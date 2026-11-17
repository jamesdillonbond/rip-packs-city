-- audit_20261003_counterparty_barren_cooldown_only_at_the_bottom
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (claim_sales_counterparty_batch)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (apply_sales_counterparty)
--
-- 2026-10-03 (known-issues #167; Trevor: "Keep going and working on anything still unresolved").
-- The buyer-only leg added by 20261003201845 had recovered ~0 of the ~96k 2025 Top Shot rows it
-- was built for. Measured: each 2-hour cycle the claim walks from the newest sale; batch 1 is the
-- fresh rows (productive), batch 2 lands on 893 never-decoded All Day rows (source
-- onchain_dapper_v1, NULL seller, 2025-12-29..2026-02-16) and applies 0 — and a BARREN pass arms
-- the cooldown (20260913190927). The re-arm then resets the cursor to the top, so the walk never
-- got below January 2026. 33 of 78 batches in 14 days were barren. The band is NOT proven
-- undecodable as a whole — only its top 120 rows were ever re-tried — so excluding the source
-- would forfeit rows nobody tested.
--
-- FIX. The claim records whether it returned a FULL batch (last_claim_full); apply arms the
-- barren-pass cooldown only after a SHORT claim, i.e. at the bottom of the walk. A full barren
-- batch just lets the cursor (already moved past it) continue downward. 09-13's property holds:
-- a small barren residue at the bottom still arms, and a productive pass never does.
-- (An existence probe for "more rows below" was measured first and rejected: the 2023 partition
-- has no leg-1 index, so it seq-scanned 1.26M rows / 39k buffers / 10.2 s.)
--
-- APPLIED 2026-10-03 ~5:53 PM PT as version 20261004005326 by an equivalent server-side rewrite at the exact
-- anchor lines, both results md5-checked against the bodies in THIS file; the cooldown armed at
-- 2026-10-04 00:02:10Z (by this defect) was cleared in the same migration:
--   UPDATE public.sales_counterparty_backfill_state SET exhausted_at = NULL, updated_at = now() WHERE id = 1;
--
-- REVERT: re-apply both previous definitions (named below), then
--   ALTER TABLE public.sales_counterparty_backfill_state DROP COLUMN last_claim_full;

ALTER TABLE public.sales_counterparty_backfill_state ADD COLUMN IF NOT EXISTS last_claim_full boolean NOT NULL DEFAULT false;

-- claim_sales_counterparty_batch: previous definition supabase/migrations/20261003201845_counterparty_lane_claims_topshot_rows_missing_only_the_buyer.sql
CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
DECLARE
  v_cursor    timestamptz;
  v_floor     timestamptz;
  v_exhausted timestamptz;
  v_rearm     interval;
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_found     integer := 0;
BEGIN
  SELECT st.cursor_sold_at, st.floor_sold_at, st.exhausted_at, st.rearm_after
    INTO v_cursor, v_floor, v_exhausted, v_rearm
  FROM public.sales_counterparty_backfill_state st
  ORDER BY st.id
  LIMIT 1;

  v_floor := COALESCE(v_floor, '2023-11-08T17:00:00Z'::timestamptz);
  v_rearm := COALESCE(v_rearm, interval '2 hours');

  -- EXHAUSTED + INSIDE THE COOLDOWN: return empty WITHOUT SCANNING. This is the branch that
  -- exists to be taken most of the time; every tick that lands here is a 195,564-buffer scan
  -- that did not happen.
  IF v_exhausted IS NOT NULL AND now() - v_exhausted < v_rearm THEN
    RETURN;
  END IF;

  -- RE-ARM: the cooldown has elapsed, so sweep from the newest row again. New sales arrive at
  -- the TOP and the cursor only ever descends, so this is the only way the lane can ever see
  -- them. Clearing the stamp here (not after the scan) means a scan that finds nothing will
  -- simply set it again below.
  IF v_exhausted IS NOT NULL THEN
    UPDATE public.sales_counterparty_backfill_state
       SET cursor_sold_at = NULL, exhausted_at = NULL, updated_at = now()
     WHERE id = 1;
    v_cursor := NULL;
  END IF;

  -- SELF-HEAL: a cursor STRICTLY BELOW the floor is invalid state, not a position (migration
  -- 20260902042214). Left alone it returns an empty range on every tick, forever, at ok=true.
  IF v_cursor IS NOT NULL AND v_cursor < v_floor THEN
    v_cursor := NULL;
  END IF;

  -- TWO LEGS (2026-10-03), each its own ordered index scan, merged newest-first:
  --   1. NULL-seller rows, as before (idx_sales_<year>_nullseller_soldat).
  --   2. BUYER-ONLY Top Shot rows: seller known, buyer NULL (idx_sales_<year>_ts_nullbuyer_soldat).
  --      Top Shot is the one collection whose buyer is in the sale tx (TopShot.Deposit.to); the
  --      worker already decodes it and apply_sales_counterparty already fills a NULL buyer, but
  --      leg 1's `seller_address IS NULL` meant these rows were never CLAIMED — 105k Top Shot
  --      sales, nearly all 2025 (ts_history_backfill_v1 97k, dune_settlement_ingest 7.9k), sat
  --      buyer-less for good; a 16-row sample decoded 16/16 (1 withdraw + 1 deposit each), 4 of
  --      them sell-backs to Dapper (#167). `sold_at >= 2025-01-01` is a CONSTANT so the planner
  --      prunes 2020–2024 (which hold none of these rows and have no index for this leg).
  IF v_cursor IS NULL THEN
    RETURN QUERY
      SELECT u.sid, u.tx, u.sat FROM (
        (SELECT s.id AS sid, s.transaction_hash::text AS tx, s.sold_at AS sat
           FROM public.sales s
          WHERE s.seller_address IS NULL
            AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= v_floor
            -- NULL-SAFE: `NOT IN` yields NULL for a NULL source, which EXCLUDES the row. IS DISTINCT FROM
            -- yields TRUE, so an unlabelled row is ATTEMPTED. Attempt-unless-known-undecodable is the
            -- right default; the other way a new writer that forgets `source` disappears silently.
            AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
            AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
            -- KNOWN-UNDECODABLE (20260913): 4,959 rows, 0.00% conversion measured as a WHOLE
            -- POPULATION over 11 days and at least two full walks. Excluded because the re-arm made
            -- the walk cyclic.
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
        UNION ALL
        (SELECT s.id, s.transaction_hash::text, s.sold_at
           FROM public.sales s
          WHERE s.collection = 'nba_top_shot'
            AND s.buyer_address IS NULL
            AND s.seller_address IS NOT NULL
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= '2025-01-01T00:00:00Z'::timestamptz
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
      ) u
      ORDER BY u.sat DESC
      LIMIT v_limit;
  ELSE
    RETURN QUERY
      SELECT u.sid, u.tx, u.sat FROM (
        (SELECT s.id AS sid, s.transaction_hash::text AS tx, s.sold_at AS sat
           FROM public.sales s
          WHERE s.seller_address IS NULL
            AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at < v_cursor
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
            AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
        UNION ALL
        (SELECT s.id, s.transaction_hash::text, s.sold_at
           FROM public.sales s
          WHERE s.collection = 'nba_top_shot'
            AND s.buyer_address IS NULL
            AND s.seller_address IS NOT NULL
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= '2025-01-01T00:00:00Z'::timestamptz
            AND s.sold_at < v_cursor
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
      ) u
      ORDER BY u.sat DESC
      LIMIT v_limit;
  END IF;

  -- GET DIAGNOSTICS AFTER `RETURN QUERY` REPORTS THE ROWS THAT QUERY ADDED TO THE RESULT SET,
  -- which is exactly what "did this scan find anything" means here. Verified on PG 16 before
  -- shipping (3 rows -> 3, empty -> 0). A zero is the drained signal - record it, so the NEXT
  -- tick takes the free branch above instead of paying for the same discovery again.
  GET DIAGNOSTICS v_found = ROW_COUNT;
  -- FULL OR SHORT (2026-10-03). A FULL batch means more claimable rows may lie below it; a SHORT
  -- one means the walk reached its bottom. apply_sales_counterparty arms the cooldown on a
  -- barren pass ONLY after a short claim — mid-walk, a barren full batch (893 never-decoded All
  -- Day rows dated 2025-12-29..2026-02-16) armed it every cycle, the re-arm sent the cursor back
  -- to the top, and the ~96k 2025 buyer-only rows below that band were never reached.
  UPDATE public.sales_counterparty_backfill_state
     SET last_claim_full = (v_found >= v_limit)
   WHERE id = 1;
  IF v_found = 0 THEN
    UPDATE public.sales_counterparty_backfill_state
       SET exhausted_at = now(), updated_at = now()
     WHERE id = 1;
  END IF;
END;
$function$;

-- apply_sales_counterparty: previous definition supabase/migrations/20260913190927_audit_20260913_a_barren_apply_pass_arms_the_counterparty_cooldown.sql
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
         -- …but ONLY AT THE BOTTOM (2026-10-03): after a FULL claim more claimable rows may lie
         -- below this batch, and arming there sent the re-armed cursor back to the top every
         -- cycle, so the walk never got past a mid-walk barren band. The cursor already moved
         -- past this batch, so a full barren pass simply continues downward; the short pass at
         -- the bottom still arms (claim_sales_counterparty_batch records which it was).
         exhausted_at   = CASE WHEN v_applied = 0 AND NOT COALESCE(last_claim_full, false)
                               THEN COALESCE(exhausted_at, now()) ELSE exhausted_at END,
         updated_at     = now()
   WHERE id = 1;

  RETURN jsonb_build_object('batch', v_n, 'applied', v_applied,
    'cursor_sold_at', (SELECT cursor_sold_at FROM public.sales_counterparty_backfill_state WHERE id=1));
END;
$function$;
