-- DB invariant: public.clear_badge_low_ask_stale(uuid,interval) — nulls out stale
-- badge_editions.low_ask rows for a collection (called from the AllDay
-- listing-cache refresh). Its load-bearing property is a DATA-LOSS SAFEGUARD: it
-- REJECTS a null/non-positive interval — without that guard a 0/NULL window would
-- satisfy `updated_at < NOW()` for EVERY row and wipe every low_ask. Otherwise it
-- clears ONLY rows that match the collection AND have a non-null low_ask AND a
-- non-null updated_at older than the window, sets updated_at, and returns the
-- count cleared.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230400_audit_20260801_snapshot_clear_badge_low_ask_stale.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (7d8a74d54de2c7bdbf740428279c4303).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE badge_editions (
  collection_id uuid,
  low_ask       numeric,
  updated_at    timestamptz
);

-- >>> BEGIN verbatim clear_badge_low_ask_stale (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.clear_badge_low_ask_stale(p_collection_id uuid, p_stale_after interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  rows_affected integer;
BEGIN
  IF p_stale_after IS NULL OR p_stale_after <= INTERVAL '0 seconds' THEN
    RAISE EXCEPTION 'p_stale_after must be a positive interval, got %', p_stale_after;
  END IF;

  WITH cleared AS (
    UPDATE badge_editions be
    SET low_ask = NULL,
        updated_at = NOW()
    WHERE be.collection_id = p_collection_id
      AND be.low_ask IS NOT NULL
      AND be.updated_at IS NOT NULL
      AND be.updated_at < NOW() - p_stale_after
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM cleared;
  RETURN rows_affected;
END;
$function$;
-- <<< END verbatim clear_badge_low_ask_stale <<<

-- CA = collection A (target), CB = collection B (bystander).
-- Seed a mix: stale-in-A (should clear), fresh-in-A (keep), null-low_ask-in-A
-- (nothing to clear), null-updated_at-in-A (guarded out), stale-in-B (wrong coll).
INSERT INTO badge_editions (collection_id, low_ask, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000aa', 12.50, now() - interval '10 days'),  -- stale A → clear
  ('00000000-0000-0000-0000-0000000000aa',  9.00, now() - interval '1 hour'),   -- fresh A → keep
  ('00000000-0000-0000-0000-0000000000aa', NULL,  now() - interval '10 days'),  -- null low_ask → nothing
  ('00000000-0000-0000-0000-0000000000aa', 30.00, NULL),                        -- null updated_at → guarded
  ('00000000-0000-0000-0000-0000000000bb', 20.00, now() - interval '10 days');  -- stale but other collection

-- 1) DATA-LOSS GUARD: a NULL interval is rejected (would otherwise wipe all).
DO $$
BEGIN
  PERFORM clear_badge_low_ask_stale('00000000-0000-0000-0000-0000000000aa', NULL);
  RAISE EXCEPTION 'expected clear_badge_low_ask_stale to reject a NULL interval';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%must be a positive interval%' THEN RAISE; END IF;
END $$;

-- 2) DATA-LOSS GUARD: a zero interval is rejected.
DO $$
BEGIN
  PERFORM clear_badge_low_ask_stale('00000000-0000-0000-0000-0000000000aa', INTERVAL '0 seconds');
  RAISE EXCEPTION 'expected clear_badge_low_ask_stale to reject a zero interval';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%must be a positive interval%' THEN RAISE; END IF;
END $$;

-- Nothing was cleared by the two rejected calls (all four A-rows intact).
SELECT _assert_eq((SELECT count(*)::text FROM badge_editions WHERE low_ask IS NOT NULL), '4',
  'rejected calls cleared nothing');

-- 3) HAPPY PATH: a 7-day window clears exactly the one stale A row and returns 1.
SELECT _assert_eq(
  clear_badge_low_ask_stale('00000000-0000-0000-0000-0000000000aa', INTERVAL '7 days')::text,
  '1', 'clears exactly the one stale in-collection low_ask');
-- The stale A row's low_ask is now NULL and its updated_at was bumped to ~now.
SELECT _assert_eq(
  (SELECT (low_ask IS NULL AND updated_at > now() - interval '1 minute')::text
     FROM badge_editions WHERE collection_id='00000000-0000-0000-0000-0000000000aa'
       AND updated_at > now() - interval '1 minute'),
  'true', 'cleared row: low_ask NULL, updated_at bumped');
-- Fresh A row untouched; other-collection stale row untouched.
SELECT _assert_eq((SELECT low_ask::text FROM badge_editions
    WHERE collection_id='00000000-0000-0000-0000-0000000000bb'), '20.00',
  'other collection is not touched');
SELECT _assert_eq((SELECT count(*)::text FROM badge_editions
    WHERE collection_id='00000000-0000-0000-0000-0000000000aa' AND low_ask = 9.00), '1',
  'the fresh in-collection row is kept');

-- 4) Re-running finds nothing new to clear (idempotent for that window).
SELECT _assert_eq(
  clear_badge_low_ask_stale('00000000-0000-0000-0000-0000000000aa', INTERVAL '7 days')::text,
  '0', 're-run clears nothing (the stale row is already NULL / freshly stamped)');

SELECT '✓ clear_badge_low_ask_stale invariants pass' AS result;
ROLLBACK;
