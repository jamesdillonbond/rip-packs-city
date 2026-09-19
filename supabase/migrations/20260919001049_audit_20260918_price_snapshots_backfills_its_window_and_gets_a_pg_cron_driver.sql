-- audit_20260918_price_snapshots_backfills_its_window_and_gets_a_pg_cron_driver
--
-- R100 (deep-audit register, 2026-09-18): `price-snapshots` wrote 1-6 of 24 hourly OHLC
-- buckets a day for at least 9 days. Re-measured live 2026-09-18 ~5:1x PM PT over the last
-- 168 hours: **0 hours with zero sales (min 10 sales/hour), 138 of 168 hours have sales but
-- NO bucket, 30 have one** -- an 82% loss, and every missing bucket is lost data, never an
-- empty hour. Two causes, both fixed here, and neither is "run it more often":
--
--   1. THE FUNCTION WROTE ONLY THE PRIOR HOUR. A tick that is missed (its only driver is
--      `.github/workflows/rpc-pipeline.yml` at 3/hour, and GitHub delivered 5 ticks in 17.8 h)
--      or that fails loses that hour FOREVER -- the next tick writes a different bucket.
--      Now it walks the last 48 completed hours and inserts what is missing (the insert was
--      already `ON CONFLICT DO NOTHING`, so every bucket is idempotent and all-or-nothing:
--      a cancelled run leaves no partial bucket). A missed or killed tick is repaired by the
--      next one instead of being lost.
--
--   2. THE HOUR-WINDOW SCAN COULD NOT USE ITS INDEX. `WHERE sold_at >= .. AND sold_at < ..`
--      alone planned as a full walk of `sales_2026_pkey` (cost 18,532); 4 of the last 5 route
--      ticks died at the service_role 30 s statement_timeout with the row `stage=rpc`. The
--      route's own header named the fix on 2026-08-08 and left it undone: adding
--      `price_usd > 0 AND edition_id IS NOT NULL` lets the planner take the partial index
--      `idx_sales_2026_fmv_recalc_window` (cost 2.66 -- a range scan). SCOPING AN AGGREGATE
--      IS AN EQUIVALENCE CLAIM, so it was proved over the population before this was written:
--      of 22,044 `sales_2026` rows in the last 7 days, 0 have NULL price, 0 have price <= 0,
--      0 have NULL edition_id -- 22,044 kept -- and 0 snapshot rows in 7 days carry a NULL
--      edition or a non-positive low. The predicate changes the PLAN and no output.
--
-- Driver: an hourly cron_heavy pg_cron job (600 s role budget, no PostgREST, no HTTP, no
-- secret in the command) through a wrapper that writes the SAME `pipeline_runs` row the route
-- writes (pipeline `price-snapshots`) and CATCHES a cancel so a killed run leaves ok=false,
-- never silence. The GHA/Vercel route stays as a second, idempotent driver. :12 so the hour's
-- sales have landed. `missing_before`/`missing_after` in `extra` is the DELTA the register
-- asked to watch (hours in the window with sales and no bucket) -- a silence arm cannot see
-- this loss at any threshold, so the watchlist row (max_silent 1800) is deliberately untouched.
--
-- FULL-BODY WRITE: the live definition was re-read immediately before this applied
-- (pg_get_functiondef, prior-hour-only body, SECURITY DEFINER, search_path public) and
-- nothing else had written it in the interval. Return shape is a SUPERSET: `status`, `bucket`
-- (prior hour), `editions_snapshotted` (rows inserted across the window this run) and
-- `computed_at` are kept for app/api/cron/price-snapshots.
--
-- REVERT: DO $$ BEGIN SET LOCAL ROLE cron_heavy; PERFORM cron.unschedule('rpc-price-snapshots-hourly'); END $$;
--         DROP FUNCTION public.run_price_snapshots_hourly_job();
--         then re-apply the prior-hour body: the same INSERT with a single
--         bucket_start := date_trunc('hour', now() - interval '1 hour') and no extra predicate.
-- anon-exec: run_price_snapshots_hourly_job (REVOKED from PUBLIC/anon/authenticated below; cron_heavy/postgres/service_role only)
-- anon-exec: pre-existing ACL kept, not a snapshot revoke — anon and authenticated EXECUTE were already false and service_role true (has_function_privilege, read live 2026-09-18 before this applied); CREATE OR REPLACE does not touch an ACL, so nothing here changes it (populate_price_snapshots_hourly)

CREATE OR REPLACE FUNCTION public.populate_price_snapshots_hourly()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_window_hours constant integer := 48;
  v_prior_bucket   timestamptz := date_trunc('hour', now() - interval '1 hour');
  v_from           timestamptz := date_trunc('hour', now() - interval '1 hour') - make_interval(hours => 47);
  v_bucket         timestamptz;
  v_n              integer := 0;
  v_prior_n        integer := 0;
  v_total          integer := 0;
  v_filled         integer := 0;
  v_scanned        integer := 0;
  v_repaired       integer := 0;
  v_missing        timestamptz[];
BEGIN
  -- Hours in the window that HAVE qualifying sales and NO 1h bucket yet. One walk of the
  -- snapshot partition (bucket range on its pkey) plus 48 cheap EXISTS probes on the partial
  -- index. Measured: 0 of 168 recent hours had zero sales, so this set is exactly the loss.
  SELECT COALESCE(array_agg(h.h ORDER BY h.h), ARRAY[]::timestamptz[])
    INTO v_missing
    FROM generate_series(v_from, v_prior_bucket, interval '1 hour') AS h(h)
   WHERE NOT EXISTS (SELECT 1 FROM price_snapshots_2026 p
                      WHERE p.bucket = h.h AND p.bucket_size = '1h')
     AND EXISTS (SELECT 1 FROM sales_2026 s
                  WHERE s.sold_at >= h.h AND s.sold_at < h.h + interval '1 hour'
                    AND s.price_usd > 0 AND s.edition_id IS NOT NULL);

  FOR v_bucket IN SELECT * FROM generate_series(v_from, v_prior_bucket, interval '1 hour') LOOP
    INSERT INTO price_snapshots_2026 (
      edition_id, collection_id, bucket, bucket_size,
      open_price, high_price, low_price, close_price, avg_price,
      volume_usd, sale_count, unique_buyers
    )
    SELECT
      s.edition_id, s.collection_id, v_bucket AS bucket, '1h' AS bucket_size,
      (array_agg(s.price_usd ORDER BY s.sold_at ASC))[1]  AS open_price,
      max(s.price_usd)                                     AS high_price,
      min(s.price_usd)                                     AS low_price,
      (array_agg(s.price_usd ORDER BY s.sold_at DESC))[1] AS close_price,
      ROUND(avg(s.price_usd), 2)                           AS avg_price,
      ROUND(sum(s.price_usd), 2)                           AS volume_usd,
      count(*)                                             AS sale_count,
      count(DISTINCT s.buyer_address)                      AS unique_buyers
    FROM sales_2026 s
    WHERE s.sold_at >= v_bucket AND s.sold_at < v_bucket + interval '1 hour'
      -- Plan-shaping predicate: rides idx_sales_2026_fmv_recalc_window. Proven output-neutral
      -- over the population (see header) -- do not remove it to "simplify".
      AND s.price_usd > 0 AND s.edition_id IS NOT NULL
    GROUP BY s.edition_id, s.collection_id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    v_scanned := v_scanned + 1;
    v_total   := v_total + v_n;
    IF v_n > 0 THEN
      v_filled := v_filled + 1;
      IF v_bucket = ANY (v_missing) THEN v_repaired := v_repaired + 1; END IF;
    END IF;
    IF v_bucket = v_prior_bucket THEN v_prior_n := v_n; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'status',               'ok',
    'bucket',               v_prior_bucket,
    'editions_snapshotted', v_total,
    'prior_bucket_rows',    v_prior_n,
    'window_hours',         c_window_hours,
    'buckets_scanned',      v_scanned,
    'buckets_filled',       v_filled,
    'missing_before',       COALESCE(array_length(v_missing, 1), 0),
    'missing_after',        COALESCE(array_length(v_missing, 1), 0) - v_repaired,
    'computed_at',          now()
  );
END;
$function$;

-- pg_cron wrapper: same terminal row the route writes, cancel caught, never silent.
CREATE OR REPLACE FUNCTION public.run_price_snapshots_hourly_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_err text := NULL;
  v_res jsonb;
BEGIN
  BEGIN
    v_res := public.populate_price_snapshots_hourly();
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled from the cron_heavy statement_timeout: the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('price-snapshots', v_started,
                                  (v_res->>'missing_before')::int,
                                  (v_res->>'editions_snapshotted')::int,
                                  0, v_ok, v_err, NULL, NULL, NULL,
                                  jsonb_build_object('via', 'pg_cron',
                                                     'stage', CASE WHEN v_ok THEN 'done' ELSE 'rpc' END,
                                                     'bucket', v_res->>'bucket',
                                                     'buckets_filled', (v_res->>'buckets_filled')::int,
                                                     'missing_before', (v_res->>'missing_before')::int,
                                                     'missing_after', (v_res->>'missing_after')::int,
                                                     'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_price_snapshots_hourly_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_price_snapshots_hourly_job() TO cron_heavy, postgres, service_role;

DO $mig$
DECLARE v_new int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-price-snapshots-hourly') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: rpc-price-snapshots-hourly already scheduled';
  END IF;
  SET LOCAL ROLE cron_heavy;
  v_new := cron.schedule('rpc-price-snapshots-hourly', '12 * * * *', 'SELECT public.run_price_snapshots_hourly_job();');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND username = 'cron_heavy' AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: job % not active as cron_heavy', v_new;
  END IF;
  RAISE NOTICE 'rpc-price-snapshots-hourly scheduled as jobid % (cron_heavy, 12 * * * *)', v_new;
END
$mig$;
