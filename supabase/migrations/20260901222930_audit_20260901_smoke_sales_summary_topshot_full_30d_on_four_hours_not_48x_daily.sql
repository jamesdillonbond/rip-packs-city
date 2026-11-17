-- audit_20260901_smoke_sales_summary_topshot_full_30d_on_four_hours_not_48x_daily
--
-- WHY: rpc_sales_summary_topshot_30d is 74.6% of analytics_smoke_run's runtime
-- (18,179 ms of a 24,363 ms mean over 23 runs, 12h to 2026-09-01 22:0xZ) and the
-- suite's single largest consumer. Measured THROUGH the function, twice, same state:
--   analytics_sales_summary(30d, topshot) = 140,221 buffers / 13,255 ms
--   analytics_sales_summary( 3d, topshot) =   8,059 buffers /    404 ms   (17.4x / 32.8x)
-- The check is LIVENESS ONLY -- it asserts prior_period exists, prior_period
-- .total_volume_usd is non-NULL, volume > 1000 and total_sales parses. Every one of
-- those is exercised identically by a 3-day window (measured 2026-09-01: has_prior=t,
-- has_prior_volume=t, volume=$24,659.81 = 24.7x the 1000 threshold, total_sales=3,316;
-- worst single day in the last 30 was $3,591.68, so a 3-day window keeps ~10x headroom
-- against the threshold at the observed floor).
--
-- Same design as audit_20260901_smoke_fmv_collection_drift_full_sweep_daily_not_48x_daily,
-- with one deliberate difference: that gate has ONE slot a day and 2026-09-01 lost it to
-- the saturation band. This gate is HOUR-ONLY on four hours, so BOTH the :13 and :43 ticks
-- run full = 8 full-window sweeps a day, and it cannot be silently disabled by a change to
-- the minute of the cron schedule.
--
-- EXPECTED: 48 x 140,221 = 6.73M buffers/day  ->  8 x 140,221 + 40 x 8,059 = 1.44M/day
--           (~5.29M buffers/day, ~41 GB/day) and ~12.9 s off 40 of 48 smoke runs, which
--           is the point: analytics_smoke_run has statement_timeout=60s and a hard kill
--           discards ALL 62 checks ("inconclusive (db saturated)", checks: []).
--
-- REVERT: re-apply this file's splices in reverse -- restore
--   WITH r AS (SELECT analytics_sales_summary(now() - interval '30 days', now(), ARRAY['topshot']::text[]) AS payload)
--   'volume_usd' -> 'volume_30d' (both in the detail object and in the severity CASE)
--   and drop the 'scope' / 'window_days' keys.
-- No signature, ACL, volatility or proconfig change in either direction, so no GRANT/REVOKE
-- is involved. proacl stays {postgres=X/postgres,service_role=X/postgres}.
--
-- anon-exec: analytics_smoke_run  (unchanged: anon=false, authenticated=false, SECURITY DEFINER)

DO $mig$
DECLARE
  v_def   text;
  v_out   text;
  v_probe jsonb;
  s1_old  text := $s1o$WITH r AS (SELECT analytics_sales_summary(now() - interval '30 days', now(), ARRAY['topshot']::text[]) AS payload)$s1o$;
  s1_new  text := $s1n$WITH g AS (
        SELECT CASE WHEN EXTRACT(hour FROM now())::int IN (2, 8, 14, 20)
                    THEN interval '30 days' ELSE interval '3 days' END AS win
      ),
      r AS (SELECT g.win AS win,
                   analytics_sales_summary(now() - g.win, now(), ARRAY['topshot']::text[]) AS payload
            FROM g)$s1n$;
  s2_old  text := $s2o$'volume_30d',         (r.payload ->> 'total_volume_usd')::numeric,$s2o$;
  s2_new  text := $s2n$'volume_usd',         (r.payload ->> 'total_volume_usd')::numeric,$s2n$;
  s3_old  text := $s3o$(r.payload ->> 'total_sales')::int$s3o$;
  s3_new  text := $s3n$(r.payload ->> 'total_sales')::int,
        'scope',              CASE WHEN r.win = interval '30 days' THEN 'full_30d' ELSE 'recent_3d' END,
        'window_days',        (EXTRACT(epoch FROM r.win) / 86400)::int$s3n$;
  s4_old  text := $s4o$(v_detail->>'volume_30d')::numeric$s4o$;
  s4_new  text := $s4n$(v_detail->>'volume_usd')::numeric$s4n$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'analytics_smoke_run';
  IF v_def IS NULL THEN RAISE EXCEPTION 'analytics_smoke_run() not found'; END IF;

  -- Guarded splice: every anchor must appear EXACTLY once, or change nothing.
  IF (length(v_def) - length(replace(v_def, s1_old, ''))) / length(s1_old) <> 1
     THEN RAISE EXCEPTION 'anchor S1 not unique (got %)', (length(v_def)-length(replace(v_def,s1_old,'')))/length(s1_old); END IF;
  IF (length(v_def) - length(replace(v_def, s2_old, ''))) / length(s2_old) <> 1
     THEN RAISE EXCEPTION 'anchor S2 not unique'; END IF;
  IF (length(v_def) - length(replace(v_def, s3_old, ''))) / length(s3_old) <> 1
     THEN RAISE EXCEPTION 'anchor S3 not unique'; END IF;
  IF (length(v_def) - length(replace(v_def, s4_old, ''))) / length(s4_old) <> 1
     THEN RAISE EXCEPTION 'anchor S4 not unique'; END IF;

  v_out := replace(v_def, s1_old, s1_new);
  v_out := replace(v_out, s2_old, s2_new);
  v_out := replace(v_out, s3_old, s3_new);
  v_out := replace(v_out, s4_old, s4_new);

  IF v_out = v_def THEN RAISE EXCEPTION 'splice produced no change'; END IF;
  IF position('IN (2, 8, 14, 20)' in v_out) = 0 THEN RAISE EXCEPTION 'gate marker absent after splice'; END IF;
  IF position($chk$'volume_30d'$chk$ in v_out) <> 0 THEN RAISE EXCEPTION 'stale volume_30d key survived the splice'; END IF;

  EXECUTE v_out;

  -- Behavioural post-state: run the SPLICED fragment itself (not the catalog) and assert
  -- the four things the check asserts. Off the gate hours this costs ~0.4 s.
  WITH g AS (
    SELECT CASE WHEN EXTRACT(hour FROM now())::int IN (2, 8, 14, 20)
                THEN interval '30 days' ELSE interval '3 days' END AS win
  ),
  r AS (SELECT g.win AS win,
               analytics_sales_summary(now() - g.win, now(), ARRAY['topshot']::text[]) AS payload
        FROM g)
  SELECT jsonb_build_object(
    'has_prior',        (r.payload -> 'prior_period') IS NOT NULL,
    'has_prior_volume', (r.payload -> 'prior_period' ->> 'total_volume_usd') IS NOT NULL,
    'volume_usd',       (r.payload ->> 'total_volume_usd')::numeric,
    'total_sales',      (r.payload ->> 'total_sales')::int,
    'scope',            CASE WHEN r.win = interval '30 days' THEN 'full_30d' ELSE 'recent_3d' END
  ) INTO v_probe FROM r;

  IF (v_probe->>'has_prior')::bool IS NOT TRUE        THEN RAISE EXCEPTION 'post-state: prior_period missing'; END IF;
  IF (v_probe->>'has_prior_volume')::bool IS NOT TRUE THEN RAISE EXCEPTION 'post-state: prior_period.total_volume_usd NULL'; END IF;
  IF COALESCE((v_probe->>'volume_usd')::numeric, 0) < 1000
     THEN RAISE EXCEPTION 'post-state: window volume % is below the 1000 warn threshold', v_probe->>'volume_usd'; END IF;
  IF v_probe->>'scope' IS NULL THEN RAISE EXCEPTION 'post-state: scope key absent'; END IF;

  RAISE NOTICE 'analytics_smoke_run spliced; probe=%', v_probe;
END
$mig$;