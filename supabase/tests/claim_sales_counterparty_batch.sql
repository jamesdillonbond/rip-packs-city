-- DB invariant: public.claim_sales_counterparty_batch(integer) — hands the
-- `sales-counterparty-backfill` worker its next batch of NULL-seller sales, and
-- since 2026-09-13 decides whether to scan AT ALL.
--
-- WHY THIS IS PINNED. The lane had stranded itself below its own work TWICE: the
-- cursor only ever descends, so once it passes the last decodable row it spends
-- every tick re-deriving the same zero — 195,564 buffers, 288 times a day, and a
-- 36–47 % `canceling statement due to statement timeout` rate under load. The
-- 2026-09-12 cursor reset cured it for SIX HOURS and then it re-stranded at the
-- byte-identical cursor value. Three properties now stop that, and each one is
-- easy to simplify away with no visible symptom until the lane is stuck again:
--   (1) a scan that finds NOTHING records `exhausted_at` — without it the next
--       tick pays for the same discovery;
--   (2) inside `rearm_after` the function returns empty AND DOES NOT SCAN — this
--       is the entire saving, and it is invisible in the return value, which is
--       empty either way;
--   (3) after `rearm_after` it re-arms the cursor to NULL, which is the ONLY way
--       the lane ever sees rows that arrived above it.
-- Property (2) is asserted by a control that cannot be faked: the sales table is
-- DROPPED, and the call must still succeed. A function that scans cannot.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261003201845_counterparty_lane_claims_topshot_rows_missing_only_the_buyer.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Only the columns the function reads. `sales` is RANGE-partitioned by sold_at in
-- production; the claim's logic does not depend on that, so a plain table is used.
CREATE TABLE sales (
  id               uuid PRIMARY KEY,
  seller_address   text,
  buyer_address    text,
  collection       text,
  transaction_hash text,
  sold_at          timestamptz,
  source           text
);

CREATE TABLE sales_counterparty_backfill_state (
  id             int PRIMARY KEY,
  cursor_sold_at timestamptz,
  floor_sold_at  timestamptz,
  exhausted_at   timestamptz,
  rearm_after    interval NOT NULL DEFAULT '2 hours',
  updated_at     timestamptz,
  last_claim_full boolean NOT NULL DEFAULT false
);

-- Two decodable rows well above the floor, and one STUDIO-HISTORY row below them
-- that the claim must never return. The excluded row is what makes "found nothing"
-- reachable without emptying the table — the production shape exactly: a drained
-- range that still contains hundreds of thousands of ineligible rows.
--
-- ⭐ THE topshot_marketplace ROW IS THE NEWEST ROW IN THE TABLE, DELIBERATELY
-- (20260913173355). Placed at the top, a claim that stops excluding it fails TWO
-- independent assertions rather than one: every `count = 2` below becomes 3, AND
-- the newest-first ordering assertion returns this row's id instead of 1111….
-- Placed at the bottom it would have been invisible to the ordering check and to
-- section B, whose stranded cursor sits above it. A skipped population needs a
-- fixture where a regression cannot hide.
INSERT INTO sales (id, seller_address, collection, transaction_hash, sold_at, source) VALUES
  ('11111111-1111-1111-1111-111111111111', NULL, 'nba_top_shot', repeat('a',64), '2026-05-01 00:00:00+00', 'onchain'),
  ('22222222-2222-2222-2222-222222222222', NULL, 'nfl_all_day',  repeat('b',64), '2026-04-01 00:00:00+00', 'onchain'),
  ('33333333-3333-3333-3333-333333333333', NULL, 'nfl_all_day',  repeat('c',64), '2024-01-01 00:00:00+00', 'allday_studio_history_v1'),
  ('44444444-4444-4444-4444-444444444444', NULL, 'nba_top_shot', repeat('d',64), '2026-06-01 00:00:00+00', 'topshot_marketplace');

INSERT INTO sales_counterparty_backfill_state (id, cursor_sold_at, floor_sold_at, exhausted_at, updated_at)
VALUES (1, NULL, '2023-11-08 17:00:00+00', NULL, now());

-- >>> BEGIN verbatim claim_sales_counterparty_batch (keep byte-identical to the migration) >>>
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
-- <<< END verbatim claim_sales_counterparty_batch <<<

-- ── A. A NORMAL SCAN STILL WORKS, AND STILL EXCLUDES WHAT IT ALWAYS DID ─────
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '2', 'both decodable rows are claimable from a NULL cursor');
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10) WHERE sale_id = '33333333-3333-3333-3333-333333333333'), '0', 'a studio-history row is never claimed');
-- 20260913173355: topshot_marketplace converts at 0.00% as a WHOLE POPULATION (4,959 rows,
-- unchanged across 11 days and two full walks) while the same lane recovered 5,507 rows from
-- other sources in the same 24 h. The exclusion is a SKIP, not a deletion — assert it directly
-- so the predicate cannot be dropped as redundant by someone reading only the WHERE clause.
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10) WHERE sale_id = '44444444-4444-4444-4444-444444444444'), '0', 'a topshot_marketplace row is never claimed');
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(1)), '1', 'p_limit still bounds the batch');
-- Newest first: the ordering the cursor depends on.
SELECT _assert_eq((SELECT sale_id::text FROM claim_sales_counterparty_batch(1)), '11111111-1111-1111-1111-111111111111', 'newest-first ordering is preserved');

-- ⭐ A scan that FOUND something must NOT arm the cooldown, or one good tick
-- would silence the lane for two hours.
SELECT _assert_eq((SELECT (exhausted_at IS NULL)::text FROM sales_counterparty_backfill_state WHERE id=1), 'true', 'a productive scan leaves exhausted_at unset');

-- ── B. A SCAN THAT FINDS NOTHING RECORDS IT ────────────────────────────────
-- Strand the cursor below every decodable row, exactly as production did: the
-- only rows underneath are studio-history, so the scan is expensive and returns 0.
UPDATE sales_counterparty_backfill_state SET cursor_sold_at = '2024-06-01 00:00:00+00' WHERE id = 1;
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '0', 'a stranded cursor finds nothing (the production state)');
SELECT _assert_eq((SELECT (exhausted_at IS NOT NULL)::text FROM sales_counterparty_backfill_state WHERE id=1), 'true', 'and the drained scan RECORDS that it found nothing');

-- ── C. INSIDE THE COOLDOWN IT DOES NOT SCAN AT ALL ─────────────────────────
-- ⭐⭐ THE CONTROL THAT CANNOT BE FAKED. The return value is empty whether the
-- function scans or short-circuits, so no assertion on the RESULT can tell the
-- two apart — and the entire point of the change is which one happens. So the
-- table the scan would read is DROPPED. A function that still scans raises
-- `relation "sales" does not exist`; one that short-circuits returns cleanly.
ALTER TABLE sales RENAME TO sales_hidden;
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '0', 'inside the cooldown the claim returns empty WITHOUT READING sales');
ALTER TABLE sales_hidden RENAME TO sales;

-- ── D. AFTER THE COOLDOWN IT RE-ARMS TO THE TOP ────────────────────────────
-- ⚠ Backdating is load-bearing: now() is the TRANSACTION timestamp, so the
-- cooldown can never elapse on its own inside this test, and every assertion
-- below would otherwise pass against a function with no re-arm branch at all.
UPDATE sales_counterparty_backfill_state SET exhausted_at = now() - interval '3 hours' WHERE id = 1;
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '2', 'after the cooldown the sweep finds the rows ABOVE the stranded cursor');
SELECT _assert_eq((SELECT (cursor_sold_at IS NULL)::text FROM sales_counterparty_backfill_state WHERE id=1), 'true', 're-arming clears the cursor, which is what lets it see newer rows');
SELECT _assert_eq((SELECT (exhausted_at IS NULL)::text FROM sales_counterparty_backfill_state WHERE id=1), 'true', 're-arming clears the exhausted stamp');

-- ⚠ `rearm_after` is the knob, and it must actually be READ rather than hardcoded.
-- With a 10-hour window the same 3-hour-old stamp must NOT re-arm.
UPDATE sales_counterparty_backfill_state
   SET exhausted_at = now() - interval '3 hours', cursor_sold_at = '2024-06-01 00:00:00+00', rearm_after = interval '10 hours'
 WHERE id = 1;
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '0', 'a longer rearm_after keeps the lane quiet — the column is read, not assumed');
SELECT _assert_eq((SELECT (cursor_sold_at IS NOT NULL)::text FROM sales_counterparty_backfill_state WHERE id=1), 'true', 'and the cursor is NOT re-armed inside the longer window');

-- ── E. THE FLOOR SELF-HEAL SURVIVED THE REWRITE ────────────────────────────
-- Pre-existing behaviour from 20260902042214: a cursor strictly below the floor
-- is invalid state, not a position, and must fall back to the top-scan rather
-- than returning an empty range forever.
UPDATE sales_counterparty_backfill_state
   SET cursor_sold_at = '2020-01-01 00:00:00+00', exhausted_at = NULL, rearm_after = interval '2 hours'
 WHERE id = 1;
SELECT _assert_eq((SELECT count(*)::text FROM claim_sales_counterparty_batch(10)), '2', 'a cursor below the floor self-heals to the top-scan');

-- ── F. BUYER-ONLY TOP SHOT ROWS ARE CLAIMED (2026-10-03) ───────────────────
-- Seller known, buyer NULL: Top Shot's buyer is in the sale tx, so these are claimable; the
-- old body's `seller_address IS NULL` never reached them (105k rows, nearly all 2025). Added
-- AFTER sections A–E so their counts stand. Each excluded shape is its own row:
INSERT INTO sales (id, seller_address, buyer_address, collection, transaction_hash, sold_at, source) VALUES
  ('55555555-5555-5555-5555-555555555555', '0xseller', NULL,    'nba_top_shot', repeat('e',64), '2025-08-01 00:00:00+00', 'ts_history_backfill_v1'), -- claimed
  ('66666666-6666-6666-6666-666666666666', '0xseller', NULL,    'nfl_all_day',  repeat('f',64), '2025-08-02 00:00:00+00', 'onchain_dapper_v2'),      -- All Day: buyer is a custodian, never claimed
  ('77777777-7777-7777-7777-777777777777', '0xseller', NULL,    'nba_top_shot', repeat('1',64), '2024-08-01 00:00:00+00', 'ts_history_backfill_v1'), -- before 2025: pruned leg, not claimed
  ('88888888-8888-8888-8888-888888888888', '0xseller', '0xbuy', 'nba_top_shot', repeat('2',64), '2025-09-01 00:00:00+00', 'ts_history_backfill_v1'), -- buyer known
  ('99999999-9999-9999-9999-999999999999', '0xseller', NULL,    'nba_top_shot', repeat('3',64), '2025-09-02 00:00:00+00', 'topshot_marketplace');    -- known-undecodable source
UPDATE sales_counterparty_backfill_state SET cursor_sold_at = NULL, exhausted_at = NULL WHERE id = 1;
SELECT _assert_eq((SELECT string_agg(sale_id::text, ',' ORDER BY sold_at DESC) FROM claim_sales_counterparty_batch(10)),
  '11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222,55555555-5555-5555-5555-555555555555',
  'both legs merge newest-first: the NULL-seller rows, then the buyer-only Top Shot row — and no All Day, pre-2025, buyer-known or marketplace row');
SELECT _assert_eq((SELECT sale_id::text FROM claim_sales_counterparty_batch(1)), '11111111-1111-1111-1111-111111111111', 'p_limit bounds the MERGED batch, newest first');
UPDATE sales_counterparty_backfill_state SET cursor_sold_at = '2026-01-01 00:00:00+00' WHERE id = 1;
SELECT _assert_eq((SELECT string_agg(sale_id::text, ',') FROM claim_sales_counterparty_batch(10)), '55555555-5555-5555-5555-555555555555',
  'the buyer-only leg honours the cursor too');

SELECT '✓ claim_sales_counterparty_batch invariants pass' AS result;
-- ── G. FULL OR SHORT (2026-10-03): the claim records whether its batch was FULL, so a barren
--    pass mid-walk does not arm the cooldown (apply_sales_counterparty reads this).
UPDATE sales_counterparty_backfill_state SET cursor_sold_at = NULL, exhausted_at = NULL WHERE id = 1;
SELECT count(*) FROM claim_sales_counterparty_batch(1);
SELECT _assert((SELECT last_claim_full FROM sales_counterparty_backfill_state WHERE id = 1),
  'a claim that filled its limit is FULL — more rows may lie below');
UPDATE sales_counterparty_backfill_state SET cursor_sold_at = NULL, exhausted_at = NULL WHERE id = 1;
SELECT count(*) FROM claim_sales_counterparty_batch(500);
SELECT _assert((SELECT NOT last_claim_full FROM sales_counterparty_backfill_state WHERE id = 1),
  'a claim that returned fewer than its limit is SHORT — the walk reached its bottom');

ROLLBACK;
