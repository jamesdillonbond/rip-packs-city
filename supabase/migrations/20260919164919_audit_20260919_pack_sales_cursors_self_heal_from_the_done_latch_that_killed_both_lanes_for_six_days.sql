-- audit_20260919_pack_sales_cursors_self_heal_from_the_done_latch
--
-- ── WHAT BROKE (measured 2026-09-19, PT afternoon) ────────────────────────────
-- `topshot_pack_sales_cursor.done` and `allday_pack_sales_cursor.done` are a
-- TERMINAL LATCH. The edge functions `backfill-topshot-pack-sales` /
-- `backfill-allday-pack-sales` read the cursor, and when `done = true` they
-- return `{"done":true}` and do nothing. NOTHING clears the flag.
--
-- Observed: topshot latched 2026-09-14 01:10Z, allday 2026-09-12 23:15Z. A
-- manual dispatch of jobid 29 at 16:38:11Z returned literally `{"done":true}`.
-- Meanwhile jobids 25/29 dispatched 478 and 477 times in 24 h and pg_cron
-- recorded every one as `succeeded` -- because a `net.http_post` succeeds when
-- the POST is ENQUEUED, never when the function did work.
--
-- Cost: `topshot_pack_sales_history` last ingested 2026-09-13 19:34Z (6 days),
-- `allday_pack_sales_history` 2026-09-12 13:46Z (7 days). Every pack-detail page
-- served sale stats silently that stale. ~960 dispatches/day hit the no-op.
--
-- ⚠ NOTHING COULD HAVE CAUGHT IT. Neither lane writes a `pipeline_runs` row
-- under any name (verified against all 196 pipelines seen in 72 h), and every
-- sentinel pipeline arm -- Pipeline Silence, Pipeline Success, Pipeline Success
-- Coverage -- is scoped to `pipeline_cadence_watchlist` over `pipeline_runs`.
-- A lane that writes no row is out of scope BY CONSTRUCTION, not by oversight.
--
-- ── THE FIX IN THIS MIGRATION ─────────────────────────────────────────────────
-- A cursor that has been `done` for longer than p_latched_minutes is un-latched
-- back to the head (`after_cursor = NULL`), which is exactly the state the lane
-- was in before 09-14 and the state the 2026-08-26 ledger entry calls "lapping
-- back to page 0". The function writes a `pipeline_runs` row on EVERY tick, so
-- these two lanes become visible to the estate's instruments for the first time.
--
-- ⚠ FRESHNESS IS READ FROM `block_time`, NOT `ingested_at`, AND THAT IS A COST
-- DECISION, NOT A PREFERENCE. There is no index on `ingested_at`; `max()` over it
-- is a seq scan of 168 MB + 141 MB, which at a 10-minute cadence would be ~45
-- GB/day -- larger than the problem this migration exists to fix. `block_time` is
-- indexed on both tables (`idx_ts_pack_sales_hist_block_time`,
-- `idx_allday_pack_sales_hist_block_time`), so `max()` is a one-row backward
-- index scan. ⚠ Consequence to keep in mind when reading the number: a flat
-- `newest_sale_at` means EITHER the lane stopped OR the market did. Pair it with
-- `cursor_updated_at` and `was_latched` in the same row before concluding.
--
-- ⚠ NO LOOP RISK AT TODAY'S CADENCE, and here is the number that bounds it. A
-- full lap is ~300k rows at ~4,000 rows/run x 20 runs/h = ~5 h, so `done` is set
-- at most ~5-hourly and this function resets at most that often. It would only
-- become a re-walk treadmill if a lap ever got SHORTER than p_latched_minutes;
-- if the pack-sales cadence is ever raised, re-derive the lap time first.
--
-- ⚠ THE BODY BELOW IS SUPERSEDED by `20260919164951`, which removes
-- `duration_ms` (a GENERATED column on pipeline_runs) from the INSERT. This file
-- is the repo's record of what was applied, verbatim, including that defect.
--
-- ── REVERT ────────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('rpc-pack-sales-cursor-unlatch');
--   DROP FUNCTION public.unlatch_pack_sales_cursors(integer);
-- To restore the exact pre-fix cursor state (it was a dead latch -- you almost
-- certainly do NOT want this, it re-kills both lanes):
--   UPDATE public.topshot_pack_sales_cursor SET done = true, total_seen = 21,
--     after_cursor = 'eyJMaXN0aW5nUmVzb3VyY2VJRCI6MTI5MjUzODg4MywiQ3Vyc29yRmllbGRzIjpbeyJGaWVsZE5hbWUiOiIobWFya2V0cGxhY2VfdHJhbnNhY3Rpb24uY3JlYXRlZF9hdCkuYmxvY2tfdGltZSIsIkZpZWxkVmFsdWUiOiIyMDIzLTEwLTAzVDE4OjI2OjM5LjQzNTc5NloiLCJGaWVsZFByaW9yaXR5IjoxfV0sIlNvcnREaXJlY3Rpb24iOiJERVNDIn0=' WHERE id = 1;
--   UPDATE public.allday_pack_sales_cursor SET done = true, total_seen = 67,
--     after_cursor = 'eyJMaXN0aW5nUmVzb3VyY2VJRCI6Nzk2Nzc1MjIxLCJDdXJzb3JGaWVsZHMiOlt7IkZpZWxkTmFtZSI6IihtYXJrZXRwbGFjZV90cmFuc2FjdGlvbi5jcmVhdGVkX2F0KS5ibG9ja190aW1lIiwiRmllbGRWYWx1ZSI6IjIwMjItMTItMDlUMjA6NDQ6MzMuODg0NDY2WiIsIkZpZWxkUHJpb3JpdHkiOjF9XSwiU29ydERpcmVjdGlvbiI6IkRFU0MifQ==' WHERE id = 1;

CREATE OR REPLACE FUNCTION public.unlatch_pack_sales_cursors(p_latched_minutes integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts_reset  int := 0;
  v_ad_reset  int := 0;
  v_ts_done   boolean;
  v_ad_done   boolean;
  v_ts_cur_at timestamptz;
  v_ad_cur_at timestamptz;
  v_ts_newest timestamptz;
  v_ad_newest timestamptz;
  v_extra     jsonb;
BEGIN
  SELECT done, updated_at INTO v_ts_done, v_ts_cur_at
    FROM public.topshot_pack_sales_cursor WHERE id = 1;
  SELECT done, updated_at INTO v_ad_done, v_ad_cur_at
    FROM public.allday_pack_sales_cursor WHERE id = 1;

  UPDATE public.topshot_pack_sales_cursor
     SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
   WHERE id = 1
     AND done
     AND updated_at < now() - make_interval(mins => p_latched_minutes);
  GET DIAGNOSTICS v_ts_reset = ROW_COUNT;

  UPDATE public.allday_pack_sales_cursor
     SET after_cursor = NULL, done = false, total_seen = 0, updated_at = now()
   WHERE id = 1
     AND done
     AND updated_at < now() - make_interval(mins => p_latched_minutes);
  GET DIAGNOSTICS v_ad_reset = ROW_COUNT;

  SELECT max(block_time) INTO v_ts_newest FROM public.topshot_pack_sales_history;
  SELECT max(block_time) INTO v_ad_newest FROM public.allday_pack_sales_history;

  v_extra := jsonb_build_object(
    'latched_minutes', p_latched_minutes,
    'topshot', jsonb_build_object(
      'was_latched',        coalesce(v_ts_done, false),
      'reset',              v_ts_reset,
      'cursor_updated_at',  v_ts_cur_at,
      'newest_sale_at',     v_ts_newest,
      'sale_age_hours',     round((extract(epoch FROM (now() - v_ts_newest))/3600)::numeric, 1)
    ),
    'allday', jsonb_build_object(
      'was_latched',        coalesce(v_ad_done, false),
      'reset',              v_ad_reset,
      'cursor_updated_at',  v_ad_cur_at,
      'newest_sale_at',     v_ad_newest,
      'sale_age_hours',     round((extract(epoch FROM (now() - v_ad_newest))/3600)::numeric, 1)
    )
  );

  INSERT INTO public.pipeline_runs
    (pipeline, started_at, finished_at, duration_ms, rows_found, rows_written, ok, extra)
  VALUES
    ('pack-sales-cursor-unlatch', v_started, clock_timestamp(),
     (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
     v_ts_reset + v_ad_reset, v_ts_reset + v_ad_reset, true, v_extra);

  RETURN v_extra;
END;
$function$;

COMMENT ON FUNCTION public.unlatch_pack_sales_cursors(integer) IS
  'Clears the terminal `done` latch on the two pack-sales cursors (see migration '
  'audit_20260919_pack_sales_cursors_self_heal_from_the_done_latch). The edge '
  'functions return {"done":true} and no-op forever once latched; nothing else '
  'resets it, and neither lane writes pipeline_runs, so a 6-day outage went '
  'unseen. Also the ONLY pipeline_runs writer for these two lanes.';

REVOKE EXECUTE ON FUNCTION public.unlatch_pack_sales_cursors(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.unlatch_pack_sales_cursors(integer) TO postgres, service_role;
