-- Leg 324 `rpc_thp_leg_impossible_parallel` (trust arm topshot_impossible_parallel_serials) was
-- killed at 600 s on four consecutive ticks at four different slots (2026-09-19 23:31, 09-20
-- 04:59, 06:52 AM PT and the :48 slot before them; 7 of its last 9 ticks). The read: 4,477
-- parallel Top Shot editions × every sale they ever had across all seven `sales` year
-- partitions (~1.3 M rows), `serial_number` fetched from the heap per row — 36–96 s on a quiet
-- box, 272 s at the last success, 600+ s under this week's IO. The covering index that would
-- make it an Index Only Scan cannot be built here: CREATE INDEX CONCURRENTLY runs as postgres
-- under the 120 s default and even the 35 MB sales_2020 partition timed out at 14:52Z today
-- (invalid index dropped, 46 s); cron_heavy cannot own the table. So the read is re-shaped.
--
-- Shape: `sales` is RANGE (sold_at) by year and the closed years (2020–2025) are immutable
-- except for deliberate re-keys (the remap_topshot_* family, the 09-09 dupe drain). Their
-- impossible-serial counts are a BASELINE held in rpc_impossible_parallel_baseline, refreshed
-- ONE year per day by a rotating cron_heavy job (stalest first, ≤ 600 s each, and a kill just
-- leaves the previous value with its own computed_at). The leg then reads baseline(2020..2025)
-- + a LIVE count over sold_at >= 2026-01-01 only (sales_2026 + sales_2027: ~23 % of the rows
-- the old read walked). If any closed year has no baseline row the leg writes 999 — unmeasured,
-- never a partial number published as whole. The trust arm's meaning is unchanged: sales whose
-- serial exceeds their parallel edition's circulation, Top Shot, known circulation only.
--
-- Seed: the last successful full read (09-19 5:48 PM PT, 272 s) returned 0, so every year's
-- baseline is 0 as of that measurement; seeded with that computed_at and a note saying so.
-- The rotation replaces each seed within six days.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: the 19:52Z (12:52 PM PT) tick of jobid 324 succeeds; the live slice alone reads under
--   200 s at that tick (duration_ms in the metric row); baseline rows show computed_at advancing
--   one year per day from 09-21. FALSIFIER: the live slice alone still dies at 600 s ⇒ the
--   2026 partition itself needs the covering index, built in the quietest hour by a human with
--   a longer budget (documented catch-22), not another re-shape.
-- REVERT: re-apply 20260920143959's rpc_thp_leg_impossible_parallel body; cron.unschedule
--   ('rpc-impossible-parallel-baseline-rotate') as cron_heavy; DROP FUNCTION the two helpers;
--   DROP TABLE public.rpc_impossible_parallel_baseline.
--
-- anon-exec: intentional — the two helpers are REVOKEd from PUBLIC, anon, authenticated below (cron_heavy + service_role only); the leg keeps its existing ACL, same signature (rpc_impossible_parallel_count, rpc_impossible_parallel_refresh_stalest_baseline, rpc_thp_leg_impossible_parallel)

CREATE TABLE IF NOT EXISTS public.rpc_impossible_parallel_baseline (
  partition_year int PRIMARY KEY,
  value          numeric NOT NULL,
  computed_at    timestamptz NOT NULL,
  duration_ms    integer,
  note           text
);
ALTER TABLE public.rpc_impossible_parallel_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rpc_impossible_parallel_baseline FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.rpc_impossible_parallel_baseline IS
  'Per-year impossible-parallel-serial counts for the CLOSED sales partitions (2020..2025), read by rpc_thp_leg_impossible_parallel and refreshed one year per day by rpc_impossible_parallel_refresh_stalest_baseline (jobid rpc-impossible-parallel-baseline-rotate). A missing year makes the leg publish 999. Added 2026-09-20.';

-- The one predicate, with a sold_at range so partition pruning does the slicing.
CREATE OR REPLACE FUNCTION public.rpc_impossible_parallel_count(p_from timestamptz, p_to timestamptz)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT count(*)::numeric
  FROM public.editions e
  JOIN public.sales s ON s.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND e.external_id::text ~ '::'::text
    AND e.circulation_count > 0
    AND s.sold_at >= p_from
    AND s.sold_at <  p_to
    AND s.serial_number > e.circulation_count;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_impossible_parallel_count(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_impossible_parallel_count(timestamptz, timestamptz) TO cron_heavy, service_role;

-- Rotating baseline refresh: the stalest closed year, one per call.
CREATE OR REPLACE FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_year    int;
  v_value   numeric;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  -- Closed years = every sales_<year> partition strictly before the current year; a year with no
  -- baseline row sorts first, then the oldest computed_at.
  SELECT y INTO v_year
  FROM generate_series(2020, extract(year FROM now())::int - 1) AS y
  LEFT JOIN public.rpc_impossible_parallel_baseline b ON b.partition_year = y
  ORDER BY b.computed_at NULLS FIRST, y
  LIMIT 1;

  BEGIN
    v_value := public.rpc_impossible_parallel_count(make_date(v_year, 1, 1)::timestamptz,
                                                     make_date(v_year + 1, 1, 1)::timestamptz);
    INSERT INTO public.rpc_impossible_parallel_baseline (partition_year, value, computed_at, duration_ms, note)
    VALUES (v_year, v_value, now(), (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int, 'rotating refresh')
    ON CONFLICT (partition_year) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms, note = EXCLUDED.note;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- A kill leaves the previous baseline row (and its computed_at) in place; the row below says so.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;

  PERFORM public.log_pipeline_run('thp-impossible-parallel-baseline', v_started, 1,
    CASE WHEN v_ok THEN 1 ELSE 0 END, 0, v_ok, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('partition_year', v_year, 'value', v_value, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('partition_year', v_year, 'value', v_value, 'ok', v_ok, 'error', v_err);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline() TO cron_heavy, service_role;

-- The leg: baseline over the closed years + the live slice. Same signature, ACL preserved.
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric; v_base numeric; v_years int; v_want int;
BEGIN
  BEGIN
    -- Closed years must ALL have a baseline row, or the arm is unmeasured (999), never a
    -- partial sum published as the whole.
    v_want := extract(year FROM now())::int - 2020;
    SELECT count(*), coalesce(sum(b.value), 0) INTO v_years, v_base
    FROM public.rpc_impossible_parallel_baseline b
    WHERE b.partition_year BETWEEN 2020 AND extract(year FROM now())::int - 1;
    IF v_years <> v_want THEN
      RAISE EXCEPTION 'impossible-parallel baseline incomplete: % of % closed years', v_years, v_want;
    END IF;
    v := v_base + public.rpc_impossible_parallel_count(
           make_date(extract(year FROM now())::int, 1, 1)::timestamptz, '2100-01-01'::timestamptz);
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;

-- Seed from the last successful full read (0 at 2026-09-19 17:48 PT = 00:48Z 09-20).
INSERT INTO public.rpc_impossible_parallel_baseline (partition_year, value, computed_at, duration_ms, note)
SELECT y, 0, '2026-09-20 00:48:00+00'::timestamptz, NULL,
       'seeded 2026-09-20 from the 09-19 5:48 PM PT full read (272 s, value 0 over all years); replaced by the rotation'
FROM generate_series(2020, 2025) AS y
ON CONFLICT (partition_year) DO NOTHING;

-- Daily rotation, cron_heavy (600 s), 19:22Z = 12:22 PM PT: hour 19Z is the estate's quietest cron
-- hour (3,714 busy-s/day, 20260920121349), thirty minutes before the leg's own 19:52Z tick.
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-impossible-parallel-baseline-rotate', '22 19 * * *',
  'SELECT public.rpc_impossible_parallel_refresh_stalest_baseline();');
RESET ROLE;

DO $$
DECLARE v_src text; v_n int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.rpc_thp_leg_impossible_parallel()'::regprocedure;
  IF strpos(v_src, 'rpc_impossible_parallel_count') = 0 THEN RAISE EXCEPTION 'leg does not read the live slice'; END IF;
  IF strpos(v_src, 'WHEN query_canceled OR OTHERS') = 0 THEN RAISE EXCEPTION 'leg lost its query_canceled catch'; END IF;
  SELECT count(*) INTO v_n FROM public.rpc_impossible_parallel_baseline WHERE partition_year BETWEEN 2020 AND 2025;
  IF v_n <> 6 THEN RAISE EXCEPTION 'baseline seed incomplete: %', v_n; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-impossible-parallel-baseline-rotate' AND username = 'cron_heavy') <> 1 THEN
    RAISE EXCEPTION 'rotation job not scheduled as cron_heavy';
  END IF;
  IF has_function_privilege('anon', 'public.rpc_impossible_parallel_count(timestamptz, timestamptz)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (count)'; END IF;
  IF has_function_privilege('anon', 'public.rpc_impossible_parallel_refresh_stalest_baseline()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (refresh)'; END IF;
  IF has_function_privilege('anon', 'public.rpc_thp_leg_impossible_parallel()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (leg)'; END IF;
END $$;
