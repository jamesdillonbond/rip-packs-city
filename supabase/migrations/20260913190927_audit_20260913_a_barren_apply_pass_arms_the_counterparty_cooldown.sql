-- audit_20260913_a_barren_apply_pass_arms_the_counterparty_cooldown
--
-- 🚨 THE `sales-counterparty-backfill` LANE CANNOT STOP ON A RESIDUE SMALLER THAN ITS BATCH, AND
-- THAT IS TRUE BY CONSTRUCTION RATHER THAN BY ACCIDENT.
--
-- `claim_sales_counterparty_batch` arms the cooldown stamp `exhausted_at` only when a scan returns
-- **ZERO** rows (`20260913074912`). A permanently undecodable remainder of fewer rows than
-- `p_limit` therefore returns the identical set on every tick, forever. Measured live today after
-- the lane drained 2026 productively (893 rows recovered in eleven ticks):
--
--   11:35:56 PT   batch 42   recovered 0   62,889 ms
--   11:41:09 PT   batch 42   recovered 0   49,052 ms
--   11:46:12 PT   batch 42   recovered 0   59,781 ms
--
-- One fixed set: 42 rows, all `onchain_dapper_v1` / `nfl_all_day`, sold 2026-01-02..02-11, all with
-- valid 64-hex tx hashes. ⛔ **NOT a source to exclude** — `onchain_dapper_v1` is 99.65%
-- seller-filled across 2026; these rows are individually undecodable, not a bad class. Cost is now
-- external rather than DB (the claim is ~100 buffers since the floor fix): **~84 failing Flow REST
-- calls per tick, ~24,000 a day.**
--
-- ── WHY THE FIX IS HERE AND NOT IN THE CLAIM ─────────────────────────────────────────────────
-- ⭐ **The claim cannot see the thing that matters.** It knows how many rows it handed out; it never
-- learns whether any of them resolved. `apply_sales_counterparty` is the ONLY place that holds both
-- facts at once — `v_n` in, `v_applied` out — and it already writes this exact state row.
--
-- ⛔ **The obvious one-liner is a REGRESSION and the repo already pins the property it breaks.**
-- Changing the claim's `IF v_found = 0` to `IF v_found < v_limit` looks right — a partial batch does
-- mean the range below the cursor is drained — but `supabase/tests/claim_sales_counterparty_batch.sql`
-- states: *"A scan that FOUND something must NOT arm the cooldown, or one good tick would silence
-- the lane for two hours."* In production a healthy cycle ENDS on a partial batch, so that version
-- would make fresh sales wait `rearm_after` (live: 2 h) for a counterparty instead of ~5 min — and
-- **the lane would read HEALTHIER, not worse**, which is the dangerous kind of regression. Not
-- shipped; recorded in [inbox 2026-09-13T1900Z] along with a second rejected containment (raising
-- the floor past the 42), which was declined because it removes the only symptom of a defect that
-- recurs — every undecodable row the walk ever reaches joins that set permanently.
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────
-- One CASE in an UPDATE the function already performs:
--   `exhausted_at = CASE WHEN v_applied = 0 THEN COALESCE(exhausted_at, now()) ELSE exhausted_at END`
--
-- ⚠ `COALESCE(exhausted_at, now())` and not `now()`: a second barren pass must NOT push a stamp that
-- is already set, or a lane that keeps waking into the same barren state would extend its own
-- cooldown indefinitely and never re-arm.
-- ⚠ The EMPTY-batch path returns before this UPDATE and is deliberately untouched — the claim
-- already owns the zero-row case, and arming here too would double-count it.
--
-- ⓘ **SECOND EFFECT, DELIBERATE, NOT A SIDE EFFECT:** a pass where every row failed because the
-- UPSTREAM is down also arms, which makes this an upstream-outage breaker of the same shape
-- `offers-sweep` carries. The price is that a transient blip buys up to `rearm_after` of quiet. That
-- is accepted: the lane is a backlog walk, the stamp self-clears, and the behaviour it replaces is
-- hammering a dead host every five minutes.
--
-- ⚠ **ONE BEHAVIOUR CHANGE BEYOND THE ARM, and it is what made the function pinnable at all:**
-- `DROP TABLE IF EXISTS _scb_inp;` before the `CREATE TEMP TABLE`. The temp table is
-- `ON COMMIT DROP`, so a SECOND call inside the same transaction failed with
-- `relation "_scb_inp" already exists`. Production never sees it (each worker call is its own
-- transaction), but the DB-invariant harness runs every case in one BEGIN/ROLLBACK — so without this
-- the function could not be pinned. Same idiom `remap_topshot_from_onchain_map()` already uses.
--
-- ── CALLERS, NAMED RATHER THAN ASSUMED ───────────────────────────────────────────────────────
-- Exactly one: `workers/sales-counterparty-backfill/index.ts` line ~168. ⚠ A grep for the name also
-- hits `public.apply_sales_counterparty_external`, but that is a PREFIX match on its own name — it
-- neither calls this function nor touches `sales_counterparty_backfill_state` (both checked against
-- its live definition), so the Dune lane's documented independence from this cursor is preserved.
--
-- ── VERIFIED BEFORE APPLYING ─────────────────────────────────────────────────────────────────
-- New pin `supabase/tests/apply_sales_counterparty.sql`, five sections, green in a local PG 16:
-- a productive pass fills/audits/counts and leaves `exhausted_at` NULL (the property the claim-side
-- version would have broken); a barren pass arms it; a second barren pass does not push it; fill-only
-- is preserved and a pass whose rows were all already filled also arms (nothing was learned); an
-- empty batch touches nothing. ⭐ **Mutation control: with the CASE removed, the barren-pass
-- assertion fails by name.**
--
-- ── REVERT ───────────────────────────────────────────────────────────────────────────────────
-- Re-apply this body with the `exhausted_at = CASE …` line removed (keep the DROP TABLE line, which
-- is orthogonal). No schema, no data change.
--
-- anon-exec: intentional — no REVOKE for apply_sales_counterparty here because this is a
-- same-signature CREATE OR REPLACE, which does not reset a function ACL.
-- Verified live BEFORE this migration (anon EXECUTE false, authenticated false, service_role true)
-- and re-verified after with has_function_privilege rather than acl text.

CREATE OR REPLACE FUNCTION public.apply_sales_counterparty(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_applied int := 0;
  v_min_sold timestamptz;
  v_n int := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('error', 'p_rows must be a json array');
  END IF;

  SELECT count(*) INTO v_n FROM jsonb_array_elements(p_rows);
  IF v_n = 0 THEN RETURN jsonb_build_object('applied', 0, 'note', 'empty batch'); END IF;

  -- ⚠ DROP FIRST (2026-09-13). The temp table is ON COMMIT DROP, so a SECOND call inside
  -- the SAME transaction hit `relation "_scb_inp" already exists`. Production never sees it
  -- (each worker call is its own transaction) but the DB-invariant harness runs every case in
  -- one BEGIN/ROLLBACK, so without this the function cannot be pinned at all. Same idiom the
  -- sibling remap_topshot_from_onchain_map() already uses for its own temp tables.
  DROP TABLE IF EXISTS _scb_inp;
  CREATE TEMP TABLE _scb_inp ON COMMIT DROP AS
  SELECT (e->>'sale_id')::uuid AS sale_id,
         NULLIF(e->>'seller','') AS seller,
         NULLIF(e->>'buyer','')  AS buyer,
         (e->>'sold_at')::timestamptz AS sold_at
  FROM jsonb_array_elements(p_rows) e;

  WITH upd AS (
    UPDATE public.sales s
       SET seller_address = COALESCE(s.seller_address, i.seller),
           buyer_address  = COALESCE(s.buyer_address,  i.buyer)
      FROM _scb_inp i
     WHERE s.id = i.sale_id
       AND (i.seller IS NOT NULL OR i.buyer IS NOT NULL)
       AND (s.seller_address IS NULL OR s.buyer_address IS NULL)
    RETURNING s.id, i.seller, i.buyer
  ),
  aud AS (
    INSERT INTO public.sales_counterparty_recovered (sale_id, seller_address, buyer_address)
    SELECT id, seller, buyer FROM upd
    ON CONFLICT (sale_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_applied FROM upd;

  SELECT min(sold_at) INTO v_min_sold FROM _scb_inp;

  UPDATE public.sales_counterparty_backfill_state
     SET cursor_sold_at = LEAST(COALESCE(cursor_sold_at, v_min_sold), v_min_sold),
         scanned        = scanned + v_n,
         recovered      = recovered + v_applied,
         undecodable    = undecodable + GREATEST(v_n - v_applied, 0),
         -- A BARREN PASS ARMS THE COOLDOWN (2026-09-13). `claim_sales_counterparty_batch`
         -- arms `exhausted_at` only on a ZERO-row scan, so a permanently undecodable
         -- residue SMALLER than the batch size can never arm it and the lane re-claims
         -- the identical rows every five minutes forever. This function is the only place
         -- that holds both facts at once — rows IN (v_n) and rows OUT (v_applied) — and the
         -- claim-side alternative (arm on a partial batch) breaks that function's pinned
         -- property that a productive scan must not silence the lane. COALESCE, not now():
         -- a second barren pass must not PUSH an armed stamp or the cooldown never ends.
         exhausted_at   = CASE WHEN v_applied = 0 THEN COALESCE(exhausted_at, now()) ELSE exhausted_at END,
         updated_at     = now()
   WHERE id = 1;

  RETURN jsonb_build_object('batch', v_n, 'applied', v_applied,
    'cursor_sold_at', (SELECT cursor_sold_at FROM public.sales_counterparty_backfill_state WHERE id=1));
END;
$function$;
