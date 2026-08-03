-- DB invariant: public.roll_pack_ask_hourly_low() → jsonb — the hourly pack-ask
-- low ratchet feeding pack deal/discount surfaces. Pins: only LISTED packs with a
-- positive ask are rolled; within an hour the ON CONFLICT keeps the LEAST (ratchets
-- DOWN only, never up); buckets older than 7 days are pruned; each pack's rolling
-- 24h and 7d minimum ask is written back to pack_ask_state; and the monitoring log
-- is best-effort (a RAISING log stub must NOT fail the roll). now() is the txn
-- timestamp here, so the windows are deterministic.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802204000_audit_20260802_snapshot_roll_pack_ask_hourly_low.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE pack_ask_state (
  collection_slug text,
  dist_id         text,
  is_listed       boolean,
  lowest_ask      numeric,
  low_ask_24h     numeric,
  low_ask_7d      numeric
);

CREATE TABLE pack_ask_hourly_low (
  collection_slug text,
  dist_id         text,
  hour_bucket     timestamptz,
  low_ask         numeric,
  UNIQUE (collection_slug, dist_id, hour_bucket)
);

-- Stub log_pipeline_run that ALWAYS RAISES — proves the roll's best-effort catch
-- keeps the roll succeeding even when monitoring fails.
CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer, p_rows_skipped integer, p_ok boolean, p_extra jsonb)
  RETURNS void LANGUAGE plpgsql AS $l$ BEGIN RAISE EXCEPTION 'stub log failure'; END $l$;

-- >>> BEGIN verbatim roll_pack_ask_hourly_low (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.roll_pack_ask_hourly_low()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_bucket  timestamptz := date_trunc('hour', now());
  v_rolled  int := 0;
  v_pruned  int := 0;
BEGIN
  INSERT INTO public.pack_ask_hourly_low (collection_slug, dist_id, hour_bucket, low_ask)
  SELECT s.collection_slug, s.dist_id, v_bucket, s.lowest_ask
  FROM public.pack_ask_state s
  WHERE s.is_listed = true AND s.lowest_ask > 0
  ON CONFLICT (collection_slug, dist_id, hour_bucket)
  DO UPDATE SET low_ask = LEAST(public.pack_ask_hourly_low.low_ask, EXCLUDED.low_ask);
  GET DIAGNOSTICS v_rolled = ROW_COUNT;

  DELETE FROM public.pack_ask_hourly_low WHERE hour_bucket < now() - interval '7 days';
  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  UPDATE public.pack_ask_state s
  SET low_ask_24h = agg.lo_24h,
      low_ask_7d  = agg.lo_7d
  FROM (
    SELECT collection_slug, dist_id,
           min(low_ask) FILTER (WHERE hour_bucket >= now() - interval '24 hours') AS lo_24h,
           min(low_ask) AS lo_7d
    FROM public.pack_ask_hourly_low
    GROUP BY collection_slug, dist_id
  ) agg
  WHERE agg.collection_slug = s.collection_slug AND agg.dist_id = s.dist_id;

  BEGIN
    PERFORM public.log_pipeline_run(
      p_pipeline   => 'pack-ask-hourly-low-roll',
      p_started_at => v_started,
      p_rows_found => v_rolled,
      p_rows_written => v_rolled,
      p_rows_skipped => v_pruned,
      p_ok         => true,
      p_extra      => jsonb_build_object('bucket', v_bucket, 'pruned', v_pruned)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL; -- monitoring log is best-effort; never fail the roll
  END;

  RETURN jsonb_build_object('bucket', v_bucket, 'rolled', v_rolled, 'pruned', v_pruned, 'at', now());
END;
$function$;
-- <<< END verbatim roll_pack_ask_hourly_low <<<

-- D1 listed ask 50 (rolls); D2 unlisted (excluded); D3 listed ask 0 (excluded).
INSERT INTO pack_ask_state (collection_slug, dist_id, is_listed, lowest_ask) VALUES
  ('nba_top_shot', 'D1', true,  50),
  ('nba_top_shot', 'D2', false, 30),
  ('nba_top_shot', 'D3', true,  0);

-- D1 hourly history: 45 (2h ago, in 24h+7d), 20 (30h ago, in 7d only), 35 (6d ago,
-- in 7d), 999 (8d ago → PRUNED).
INSERT INTO pack_ask_hourly_low (collection_slug, dist_id, hour_bucket, low_ask) VALUES
  ('nba_top_shot','D1', date_trunc('hour', now()) - interval '2 hours',  45),
  ('nba_top_shot','D1', date_trunc('hour', now()) - interval '30 hours', 20),
  ('nba_top_shot','D1', date_trunc('hour', now()) - interval '6 days',   35),
  ('nba_top_shot','D1', date_trunc('hour', now()) - interval '8 days',   999);

-- First roll: even though the log stub RAISES, the roll must succeed.
SELECT _assert_eq(roll_pack_ask_hourly_low()->>'rolled', '1', 'only D1 (listed + positive) rolled; best-effort log failure did not fail the roll');
SELECT _assert_eq((SELECT jsonb_build_object('r', roll_pack_ask_hourly_low())->>'r'), (SELECT jsonb_build_object('r', roll_pack_ask_hourly_low())->>'r'), 'roll is callable repeatedly (no temp-table/txn hazard)');

-- Re-read state after the (idempotent-in-this-bucket) rolls above.
SELECT _assert_eq((SELECT low_ask::text FROM pack_ask_hourly_low WHERE dist_id='D1' AND hour_bucket = date_trunc('hour', now())), '50', 'current-hour bucket recorded D1 ask 50');
SELECT _assert_eq((SELECT count(*)::text FROM pack_ask_hourly_low WHERE dist_id='D2'), '0', 'unlisted D2 not rolled');
SELECT _assert_eq((SELECT count(*)::text FROM pack_ask_hourly_low WHERE dist_id='D3'), '0', 'zero-ask D3 not rolled');
SELECT _assert_eq((SELECT count(*)::text FROM pack_ask_hourly_low WHERE dist_id='D1' AND hour_bucket = date_trunc('hour', now()) - interval '8 days'), '0', '8-day-old bucket pruned');

-- Aggregates on pack_ask_state: 24h = min(current 50, 2h 45) = 45; 7d = min all = 20.
SELECT _assert_eq((SELECT low_ask_24h::text FROM pack_ask_state WHERE dist_id='D1'), '45', 'D1 low_ask_24h = min over last 24h buckets (50, 45)');
SELECT _assert_eq((SELECT low_ask_7d::text  FROM pack_ask_state WHERE dist_id='D1'), '20', 'D1 low_ask_7d = min over all retained buckets (incl 30h-old 20)');
SELECT _assert(( (SELECT low_ask_24h FROM pack_ask_state WHERE dist_id='D2') IS NULL ), 'D2 (not rolled) aggregates stay NULL');

-- Hourly LEAST ratchet: lower D1 ask to 40 → current bucket ratchets DOWN to 40.
UPDATE pack_ask_state SET lowest_ask = 40 WHERE dist_id='D1';
SELECT roll_pack_ask_hourly_low();
SELECT _assert_eq((SELECT low_ask::text FROM pack_ask_hourly_low WHERE dist_id='D1' AND hour_bucket = date_trunc('hour', now())), '40', 'lower ask ratchets the hour bucket DOWN to 40');

-- Raise D1 ask to 100 → LEAST keeps 40 (the hourly low never goes UP within the hour).
UPDATE pack_ask_state SET lowest_ask = 100 WHERE dist_id='D1';
SELECT roll_pack_ask_hourly_low();
SELECT _assert_eq((SELECT low_ask::text FROM pack_ask_hourly_low WHERE dist_id='D1' AND hour_bucket = date_trunc('hour', now())), '40', 'higher ask does NOT raise the hourly low (LEAST ratchet holds)');

SELECT '✓ roll_pack_ask_hourly_low invariants pass' AS result;
ROLLBACK;
