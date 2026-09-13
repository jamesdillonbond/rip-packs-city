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
-- (supabase/migrations/20260913074912_audit_20260913_sales_counterparty_claim_rearms_instead_of_rescanning_a_drained_range.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Only the columns the function reads. `sales` is RANGE-partitioned by sold_at in
-- production; the claim's logic does not depend on that, so a plain table is used.
CREATE TABLE sales (
  id               uuid PRIMARY KEY,
  seller_address   text,
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
  updated_at     timestamptz
);

-- Two decodable rows well above the floor, and one STUDIO-HISTORY row below them
-- that the claim must never return. The excluded row is what makes "found nothing"
-- reachable without emptying the table — the production shape exactly: a drained
-- range that still contains hundreds of thousands of ineligible rows.
INSERT INTO sales (id, seller_address, collection, transaction_hash, sold_at, source) VALUES
  ('11111111-1111-1111-1111-111111111111', NULL, 'nba_top_shot', repeat('a',64), '2026-05-01 00:00:00+00', 'onchain'),
  ('22222222-2222-2222-2222-222222222222', NULL, 'nfl_all_day',  repeat('b',64), '2026-04-01 00:00:00+00', 'onchain'),
  ('33333333-3333-3333-3333-333333333333', NULL, 'nfl_all_day',  repeat('c',64), '2024-01-01 00:00:00+00', 'allday_studio_history_v1');

INSERT INTO sales_counterparty_backfill_state (id, cursor_sold_at, floor_sold_at, exhausted_at, updated_at)
VALUES (1, NULL, '2023-11-08 17:00:00+00', NULL, now());

-- >>> BEGIN verbatim claim_sales_counterparty_batch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
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

  IF v_cursor IS NULL THEN
    RETURN QUERY
      SELECT s.id, s.transaction_hash::text, s.sold_at
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
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  ELSE
    RETURN QUERY
      SELECT s.id, s.transaction_hash::text, s.sold_at
      FROM public.sales s
      WHERE s.seller_address IS NULL
        AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
        AND s.transaction_hash ~ '^[0-9a-f]{64}$'
        AND s.sold_at < v_cursor
        AND s.sold_at >= v_floor
        AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
        AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
      ORDER BY s.sold_at DESC
      LIMIT v_limit;
  END IF;

  -- ⚠ GET DIAGNOSTICS AFTER `RETURN QUERY` REPORTS THE ROWS THAT QUERY ADDED TO THE RESULT
  -- SET, which is exactly what "did this scan find anything" means here. A zero is the
  -- drained signal — record it, so the NEXT tick takes the free branch above instead of
  -- paying for the same discovery again.
  GET DIAGNOSTICS v_found = ROW_COUNT;
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

SELECT '✓ claim_sales_counterparty_batch invariants pass' AS result;
ROLLBACK;
