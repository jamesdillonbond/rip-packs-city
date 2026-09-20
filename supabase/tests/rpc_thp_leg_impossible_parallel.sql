-- DB invariant: public.rpc_thp_leg_impossible_parallel — one leg of the trust-board precompute.
--
-- Counts Top Shot sales whose serial number exceeds the edition's circulation —
-- physically impossible, and the tell for the parallel/base conflation family that
-- mis-keys sales onto the wrong edition. Runs alone on pg_cron jobid 324
-- (`52 1,7,13,19 * * *` since 20260920121349).
--
-- Two filters carry the meaning and each is asserted in BOTH directions, because a
-- guard that only ever sees inputs it accepts is unobservable:
--   `external_id ~ '::'`  — PARALLEL printings only. A base-keyed edition with an
--                           impossible serial is deliberately NOT counted; the arm
--                           is named for, and thresholded against, parallels.
--   `circulation_count>0` — an edition whose circulation we do not know is 0, and
--                           without this guard EVERY serial would exceed it, so a
--                           catalog gap would masquerade as mass conflation.
--
-- ⭐ SHAPE SINCE 2026-09-20 (20260920150414): the value is a per-MONTH BASELINE over every closed
-- month since 2020-01 (rpc_impossible_parallel_baseline, refreshed stalest-first inside a soft
-- budget by rpc_impossible_parallel_refresh_stalest_baseline, 20260920151857) PLUS a live
-- count over the CURRENT MONTH only. Four 600 s kills at four slots proved the whole-history read
-- does not fit this instance's IO; the closed years are immutable except by deliberate
-- re-keys, which the rotation picks up within days. A missing closed month makes
-- the leg publish 999 — unmeasured, never a partial sum as the whole.
--
-- The function DDL below is VERBATIM from its committed migration.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.rpc_trust_health_precompute (
  metric      text PRIMARY KEY,
  value       numeric,
  computed_at timestamptz,
  duration_ms numeric
);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, circulation_count int
);
CREATE TABLE public.sales (
  edition_id uuid, serial_number int, sold_at timestamptz
);
CREATE TABLE public.rpc_impossible_parallel_baseline (
  period_start date PRIMARY KEY,
  value          numeric NOT NULL,
  computed_at    timestamptz NOT NULL,
  duration_ms    integer,
  note           text
);
CREATE TABLE public.pipeline_runs (
  pipeline text, collection_slug text, started_at timestamptz, finished_at timestamptz,
  rows_found int, rows_written int, rows_skipped int, ok boolean, error text, extra jsonb
);
CREATE OR REPLACE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz,
  p_rows_found int DEFAULT NULL, p_rows_written int DEFAULT NULL, p_rows_skipped int DEFAULT NULL,
  p_ok boolean DEFAULT true, p_error text DEFAULT NULL, p_collection_slug text DEFAULT NULL,
  p_cursor text DEFAULT NULL, p_next text DEFAULT NULL, p_extra jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written, rows_skipped, ok, error, extra)
  VALUES (p_pipeline, p_collection_slug, p_started_at, clock_timestamp(), p_rows_found, p_rows_written, p_rows_skipped, p_ok, p_error, p_extra);
$$;

INSERT INTO public.editions (id, collection_id, external_id, circulation_count) VALUES
  -- parallel, known circulation — the only shape that can be counted
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd','12:34::7', 100),
  -- BASE-keyed edition, same impossible serial: must NOT count
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd','12:34',    100),
  -- parallel with UNKNOWN circulation (0): must NOT count, or a catalog gap reads
  -- as mass conflation
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd','56:78::1',   0),
  -- AllDay parallel, impossible serial: must NOT count (the arm is Top-Shot-scoped)
  ('44444444-4444-4444-4444-444444444444','dee28451-5d62-409e-a1ad-a83f763ac070','9:9::9',   100);

-- Live rows (this month) and closed-month rows: the leg must count only the live ones itself.
INSERT INTO public.sales (edition_id, serial_number, sold_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 101, date_trunc('month', now()) + interval '1 day'),  -- impossible, LIVE  -> COUNTS
  ('11111111-1111-1111-1111-111111111111', 250, date_trunc('month', now()) + interval '2 days'),  -- impossible, LIVE  -> COUNTS
  ('11111111-1111-1111-1111-111111111111', 100, date_trunc('month', now()) + interval '3 days'),  -- exactly at circulation: LEGAL
  ('11111111-1111-1111-1111-111111111111',  50, date_trunc('month', now()) + interval '4 days'),  -- legal
  ('11111111-1111-1111-1111-111111111111', 300, '2023-06-01'),                                       -- impossible, CLOSED MONTH -> baseline only
  ('22222222-2222-2222-2222-222222222222', 999, date_trunc('month', now()) + interval '5 hours'),   -- base-keyed  -> excluded
  ('33333333-3333-3333-3333-333333333333',   1, date_trunc('month', now()) + interval '5 hours'),   -- circ 0      -> excluded
  ('44444444-4444-4444-4444-444444444444', 999, date_trunc('month', now()) + interval '5 hours');   -- AllDay      -> excluded

-- >>> BEGIN verbatim rpc_impossible_parallel_count (byte-identical to the migration/prod) >>>
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
-- <<< END verbatim rpc_impossible_parallel_count <<<

-- >>> BEGIN verbatim rpc_impossible_parallel_refresh_stalest_baseline (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_impossible_parallel_refresh_stalest_baseline(p_budget_seconds integer DEFAULT 420)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_month   date;
  v_value   numeric;
  v_t0      timestamptz;
  v_n       int := 0;
  v_ok      boolean := true;
  v_err     text := NULL;
  v_months  jsonb := '[]'::jsonb;
BEGIN
  -- Closed months = 2020-01 .. the month before the current one. A month with no row sorts
  -- first, then the oldest computed_at. One month per statement; stop when the soft budget is
  -- spent (the cron_heavy 600 s budget covers the whole call; 420 s leaves the log row room).
  -- computed_at is stamped with clock_timestamp(), never now(): now() is the transaction start
  -- and sorts BEFORE v_started, which made every freshly written month read as stale again.
  LOOP
    EXIT WHEN clock_timestamp() - v_started > make_interval(secs => p_budget_seconds);
    SELECT m::date INTO v_month
    FROM generate_series('2020-01-01'::date, (date_trunc('month', now()) - interval '1 month')::date, interval '1 month') AS m
    LEFT JOIN public.rpc_impossible_parallel_baseline b ON b.period_start = m::date
    WHERE b.period_start IS NULL OR b.computed_at < v_started
    ORDER BY b.computed_at NULLS FIRST, m
    LIMIT 1;
    EXIT WHEN v_month IS NULL;   -- everything refreshed since this run began
    BEGIN
      v_t0 := clock_timestamp();
      v_value := public.rpc_impossible_parallel_count(v_month::timestamptz, (v_month + interval '1 month')::timestamptz);
      INSERT INTO public.rpc_impossible_parallel_baseline (period_start, value, computed_at, duration_ms, note)
      VALUES (v_month, v_value, clock_timestamp(), (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int, 'rotating refresh')
      ON CONFLICT (period_start) DO UPDATE
        SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at,
            duration_ms = EXCLUDED.duration_ms, note = EXCLUDED.note;
      v_n := v_n + 1;
      v_months := v_months || to_jsonb(v_month);
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      -- A kill leaves the previous row for that month (and its computed_at) in place.
      v_ok := false;
      v_err := SQLSTATE || ': ' || SQLERRM || ' (month ' || v_month || ')';
      EXIT;
    END;
  END LOOP;

  PERFORM public.log_pipeline_run('thp-impossible-parallel-baseline', v_started, v_n, v_n, 0, v_ok, v_err,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('months_refreshed', v_n, 'months', v_months, 'via', 'pg_cron',
                       'budget_seconds', p_budget_seconds,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('months_refreshed', v_n, 'ok', v_ok, 'error', v_err);
END;
$function$;
-- <<< END verbatim rpc_impossible_parallel_refresh_stalest_baseline <<<

-- >>> BEGIN verbatim rpc_thp_leg_impossible_parallel (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric; v_base numeric; v_months int; v_want int;
BEGIN
  BEGIN
    -- Every closed month (2020-01 .. last month) must have a baseline row, or the arm is
    -- unmeasured (999) — never a partial sum published as the whole.
    v_want := (extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1;
    SELECT count(*), coalesce(sum(b.value), 0) INTO v_months, v_base
    FROM public.rpc_impossible_parallel_baseline b
    WHERE b.period_start >= '2020-01-01' AND b.period_start < date_trunc('month', now())::date;
    IF v_months <> v_want THEN
      RAISE EXCEPTION 'impossible-parallel baseline incomplete: % of % closed months', v_months, v_want;
    END IF;
    v := v_base + public.rpc_impossible_parallel_count(date_trunc('month', now()), '2100-01-01'::timestamptz);
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
-- <<< END verbatim rpc_thp_leg_impossible_parallel <<<

-- The shared predicate, sliced by year: the closed-year row is only visible in its year.
SELECT _assert_eq(public.rpc_impossible_parallel_count('2023-01-01', '2024-01-01')::text, '1',
  'the 2023 slice sees exactly the one impossible 2023 sale');
SELECT _assert_eq(public.rpc_impossible_parallel_count(date_trunc('month', now()), '2100-01-01')::text, '2',
  'the live slice sees exactly the two impossible live sales; base-keyed, unknown-circulation '
  'and non-Top-Shot rows are all excluded');

-- No baseline yet ⇒ the leg is UNMEASURED (999), never a partial sum published as whole.
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_impossible_parallel_serials'), '999',
  'with no baseline rows the leg publishes the 999 sentinel, not the live count alone');

-- The rotation fills every missing month inside its soft budget (all of them here: the fixture
-- is tiny), stalest-first, and logs one row per run with the count.
SELECT _assert_eq((public.rpc_impossible_parallel_refresh_stalest_baseline(60)->>'months_refreshed'),
  ((extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1)::text,
  'one full rotation fills every closed month from 2020-01 to last month');
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_impossible_parallel_baseline),
  ((extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1)::text,
  'one baseline row per closed month');
SELECT _assert_eq((SELECT value::text FROM public.rpc_impossible_parallel_baseline WHERE period_start = '2023-06-01'), '1',
  'the 2023-06 baseline holds the one closed-month impossible sale');
SELECT _assert_eq((SELECT count(*)::text FROM public.pipeline_runs WHERE pipeline = 'thp-impossible-parallel-baseline' AND ok), '1',
  'the rotation logs one pipeline_runs row per run');
SELECT _assert_eq((public.rpc_impossible_parallel_refresh_stalest_baseline(60)->>'months_refreshed'),
  ((extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1)::text,
  'a second run refreshes every month again — each is older than that run''s start, and the '
  'budget fits them all here; a run never re-refreshes a month it wrote itself (the 9,074 bug)');

-- With the baseline complete: value = baseline + live = 1 + 2.
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_impossible_parallel_serials'), '3',
  'baseline (closed months) + live (this month): 1 + 2');

-- The boundary is `>`, not `>=`: serial N of an edition of N is the LAST MINT, the
-- most collectible serial there is. Counting it would flag every last mint on the
-- platform as evidence of conflation.
SELECT _assert((SELECT count(*) FROM public.sales s JOIN public.editions e ON e.id = s.edition_id
                 WHERE s.serial_number = e.circulation_count) = 1,
  'the fixture really does contain a serial exactly AT circulation, so the > boundary is observable');

-- The rotation picks the STALEST month first, and a re-key in a closed month is picked up by it.
UPDATE public.rpc_impossible_parallel_baseline SET computed_at = now() - interval '9 days' WHERE period_start = '2023-06-01';
INSERT INTO public.sales (edition_id, serial_number, sold_at) VALUES ('11111111-1111-1111-1111-111111111111', 400, '2023-06-15');
SELECT _assert_eq((SELECT (public.rpc_impossible_parallel_refresh_stalest_baseline(60)->'months_refreshed')::text), (
  (extract(year FROM now())::int - 2020) * 12 + extract(month FROM now())::int - 1)::text,
  'a later run refreshes every month again (all are older than its start)');
SELECT _assert_eq((SELECT value::text FROM public.rpc_impossible_parallel_baseline WHERE period_start = '2023-06-01'), '2',
  'a re-keyed closed-month row reaches the baseline on the next rotation');
SELECT _assert((SELECT min(computed_at) FROM public.rpc_impossible_parallel_baseline) > now() - interval '1 minute',
  'the stalest month was not left behind');

-- Idempotent + refreshes computed_at (the max-age arm is the only freshness instrument).
UPDATE public.rpc_trust_health_precompute SET computed_at = now() - interval '20 hours';
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '1',
  're-running updates in place (ON CONFLICT), it does not append');
SELECT _assert((SELECT now() - computed_at FROM public.rpc_trust_health_precompute) < interval '1 minute',
  're-running refreshes computed_at');

-- The 999 sentinel DOES fire on an ordinary error (42P01 here).
SAVEPOINT generic_err;
DROP TABLE public.sales;
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_impossible_parallel_serials'), '999',
  'an ordinary error flips the arm to the loud 999 sentinel, which is above the breach '
  'threshold of 3 — a failed leg pages rather than publishing a stale value as current');
ROLLBACK TO SAVEPOINT generic_err;

-- ── ✅ THE SENTINEL IS REACHABLE ON A STATEMENT TIMEOUT (R118, 2026-09-20) ──
-- PostgreSQL: OTHERS excludes QUERY_CANCELED, so until 2026-09-20 the handler was blind
-- to the one failure this instance produces. Each leg now runs alone under
-- run_thp_leg_logged (the 08-16 8-way split), so after a caught cancel the only remaining
-- work is this INSERT and one log row; `WHEN query_canceled OR OTHERS` since 20260920143959.
-- If a future change makes the sentinel UNREACHABLE again, THIS TEST MUST FAIL.
CREATE FUNCTION public._cancel() RETURNS TABLE(edition_id uuid, serial_number int, sold_at timestamptz)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.sales;
CREATE VIEW public.sales AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_impossible_parallel();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(NOT caught, 'a 57014 is CAUGHT inside the leg (WHEN query_canceled OR OTHERS, R118) — it no longer escapes');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '1',
  'the 999 sentinel IS written on a timeout — the arm writes its loud failure value instead of '
  'publishing a frozen number as current (v_rpc_trust_health has no per-metric age column)');

SELECT '✓ rpc_thp_leg_impossible_parallel invariants pass' AS result;

ROLLBACK;
