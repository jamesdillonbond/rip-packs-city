-- DB invariant: public.apply_sales_counterparty(jsonb) → jsonb
-- — the write half of the `sales-counterparty-backfill` lane. It takes the rows the
-- Cloudflare worker decoded, fills `sales.seller_address`/`buyer_address` FILL-ONLY,
-- audits each fill, moves the walk cursor, and — since 2026-09-13 — decides whether
-- the lane should STOP.
--
-- WHY THIS IS PINNED (2026-09-13). The lane's cooldown stamp `exhausted_at` was armed
-- only by `claim_sales_counterparty_batch` on a scan that returned ZERO rows. **Any
-- permanently undecodable residue SMALLER than the batch size can therefore never arm
-- it**, and the lane re-claims the identical rows every five minutes forever. Measured
-- the day this was written: the same **42** rows (`onchain_dapper_v1` / `nfl_all_day`,
-- all with valid tx hashes), ~55 s and ~84 failing Flow REST calls per tick, ~24,000 a
-- day, recovering nothing.
--
-- ⭐ THE FIX BELONGS HERE AND NOT IN THE CLAIM, and that is the whole point of this
-- file. The claim cannot see the thing that matters: it knows only how many rows it
-- handed out, never whether any of them resolved. **This function is the only place
-- that holds both facts at once** — `v_n` in, `v_applied` out. The obvious one-line
-- alternative (arm the claim on a PARTIAL batch, `v_found < v_limit`) is a REGRESSION
-- and `supabase/tests/claim_sales_counterparty_batch.sql` already pins the property it
-- breaks: *"a scan that FOUND something must NOT arm the cooldown, or one good tick
-- would silence the lane for two hours."* A healthy cycle ends on a partial batch, so
-- that version would make fresh sales wait `rearm_after` for a counterparty — and the
-- lane would read HEALTHIER, not worse. Do not "simplify" this into the claim.
--
-- ⓘ THE SECOND EFFECT IS DELIBERATE AND IS NOT A SIDE EFFECT: a pass where every row
-- failed to decode because the UPSTREAM is down also arms the cooldown, which makes
-- this an upstream-outage breaker of the same shape `offers-sweep` carries. The cost is
-- that a transient blip buys up to `rearm_after` of quiet. That is accepted: the lane
-- is a backlog walk, the stamp self-clears, and the alternative it replaces is
-- hammering a dead host every five minutes.
--
-- ⚠ `COALESCE(exhausted_at, now())` rather than `now()`: a barren pass must not PUSH a
-- stamp that is already set, or a lane that keeps waking into the same barren state
-- would extend its own cooldown indefinitely and never re-arm.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260913190927_audit_20260913_a_barren_apply_pass_arms_the_counterparty_cooldown.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE sales (
  id             uuid PRIMARY KEY,
  seller_address text,
  buyer_address  text
);

CREATE TABLE sales_counterparty_recovered (
  sale_id        uuid PRIMARY KEY,
  seller_address text,
  buyer_address  text
);

CREATE TABLE sales_counterparty_backfill_state (
  id             int PRIMARY KEY,
  cursor_sold_at timestamptz,
  scanned        bigint NOT NULL DEFAULT 0,
  recovered      bigint NOT NULL DEFAULT 0,
  undecodable    bigint NOT NULL DEFAULT 0,
  exhausted_at   timestamptz,
  updated_at     timestamptz
);

INSERT INTO sales (id, seller_address, buyer_address) VALUES
  ('11111111-1111-1111-1111-111111111111', NULL, NULL),  -- decodable
  ('22222222-2222-2222-2222-222222222222', NULL, NULL),  -- decodable
  ('33333333-3333-3333-3333-333333333333', NULL, NULL),  -- UNdecodable (worker sends nulls)
  ('44444444-4444-4444-4444-444444444444', '0xalready', '0xalready');  -- already filled

INSERT INTO sales_counterparty_backfill_state (id, cursor_sold_at, exhausted_at, updated_at)
VALUES (1, NULL, NULL, now());

-- >>> BEGIN verbatim apply_sales_counterparty (keep byte-identical to the migration) >>>
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
-- <<< END verbatim apply_sales_counterparty <<<

-- ── A. A PRODUCTIVE PASS FILLS, AUDITS, COUNTS — AND LEAVES THE LANE RUNNING ───
SELECT _assert_eq(
  (SELECT (apply_sales_counterparty('[
     {"sale_id":"11111111-1111-1111-1111-111111111111","seller":"0xaaa","buyer":"0xbbb","sold_at":"2026-05-01T00:00:00Z"},
     {"sale_id":"33333333-3333-3333-3333-333333333333","seller":null,"buyer":null,"sold_at":"2026-04-01T00:00:00Z"}
   ]'::jsonb))->>'applied'), '1', 'a pass applies only the rows that actually decoded');
SELECT _assert_eq((SELECT seller_address FROM sales WHERE id='11111111-1111-1111-1111-111111111111'), '0xaaa', 'the decoded row is filled');
SELECT _assert_eq((SELECT count(*)::text FROM sales_counterparty_recovered), '1', 'every fill is audited');
SELECT _assert_eq((SELECT scanned::text FROM sales_counterparty_backfill_state WHERE id=1), '2', 'scanned counts the whole batch, not just the fills');
SELECT _assert_eq((SELECT undecodable::text FROM sales_counterparty_backfill_state WHERE id=1), '1', 'undecodable counts the misses');
-- ⭐ THE PROPERTY THE CLAIM-SIDE VERSION OF THIS FIX WOULD HAVE BROKEN.
SELECT _assert((SELECT exhausted_at IS NULL FROM sales_counterparty_backfill_state WHERE id=1),
  'a pass that recovered something leaves the lane RUNNING — arming here would silence it for rearm_after after every good tick');

-- ── B. A BARREN PASS ARMS THE COOLDOWN ────────────────────────────────────────
-- This is the 42-row residue in miniature: rows come in, nothing decodes, and without
-- this the lane re-claims the identical set every five minutes forever.
SELECT _assert_eq(
  (SELECT (apply_sales_counterparty('[
     {"sale_id":"33333333-3333-3333-3333-333333333333","seller":null,"buyer":null,"sold_at":"2026-03-01T00:00:00Z"}
   ]'::jsonb))->>'applied'), '0', 'a barren pass applies nothing');
SELECT _assert((SELECT exhausted_at IS NOT NULL FROM sales_counterparty_backfill_state WHERE id=1),
  'a pass that recovered NOTHING arms the cooldown — the claim cannot see this, only this function can');

-- ── C. A SECOND BARREN PASS DOES NOT PUSH THE STAMP FORWARD ───────────────────
-- Otherwise a lane that keeps waking into the same barren state extends its own
-- cooldown indefinitely and never re-arms.
UPDATE sales_counterparty_backfill_state SET exhausted_at = '2020-01-01T00:00:00Z' WHERE id = 1;
SELECT apply_sales_counterparty('[
  {"sale_id":"33333333-3333-3333-3333-333333333333","seller":null,"buyer":null,"sold_at":"2026-02-01T00:00:00Z"}
]'::jsonb);
-- ⚠ compared AT TIME ZONE UTC: a bare timestamptz::text renders in the session TimeZone,
-- so this assertion would pass or fail depending on who ran it.
SELECT _assert_eq((SELECT (exhausted_at AT TIME ZONE 'UTC')::text FROM sales_counterparty_backfill_state WHERE id=1), '2020-01-01 00:00:00',
  'an already-armed stamp is NOT pushed forward by a second barren pass');

-- ── D. FILL-ONLY IS PRESERVED ─────────────────────────────────────────────────
-- The lane must never overwrite a counterparty another source already established.
UPDATE sales_counterparty_backfill_state SET exhausted_at = NULL WHERE id = 1;
SELECT apply_sales_counterparty('[
  {"sale_id":"44444444-4444-4444-4444-444444444444","seller":"0xWRONG","buyer":"0xWRONG","sold_at":"2026-01-01T00:00:00Z"}
]'::jsonb);
SELECT _assert_eq((SELECT seller_address FROM sales WHERE id='44444444-4444-4444-4444-444444444444'), '0xalready',
  'an already-filled seller is never overwritten');
-- ⚠ And that row counts as APPLIED-NOTHING, so it arms — which is correct: the lane
-- learned nothing from the pass.
SELECT _assert((SELECT exhausted_at IS NOT NULL FROM sales_counterparty_backfill_state WHERE id=1),
  'a pass whose every row was already filled also arms — nothing was learned');

-- ── E. AN EMPTY BATCH RETURNS EARLY AND TOUCHES NOTHING ───────────────────────
UPDATE sales_counterparty_backfill_state SET exhausted_at = NULL, scanned = 0 WHERE id = 1;
SELECT _assert_eq((SELECT (apply_sales_counterparty('[]'::jsonb))->>'applied'), '0', 'an empty batch applies nothing');
SELECT _assert((SELECT exhausted_at IS NULL FROM sales_counterparty_backfill_state WHERE id=1),
  'an EMPTY batch must NOT arm — the claim already owns the zero-row case, and arming here would double-count it');
SELECT _assert_eq((SELECT scanned::text FROM sales_counterparty_backfill_state WHERE id=1), '0', 'an empty batch does not move the counters');

SELECT '✓ apply_sales_counterparty invariants pass' AS result;
ROLLBACK;
