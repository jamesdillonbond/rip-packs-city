-- DB invariant: public.check_pipeline_cadence_collapse() — the RATE arm.
--
-- WHY IT IS PINNED. It exists because a SILENCE detector cannot see a cadence
-- collapse: the `cron_silent` arm fires at 1,800 minutes, so a lane ticking every
-- 177 minutes is never 30 h silent while every tick reads `ok = true`. Nine lanes
-- ran at 1/12th cadence for two days on exactly that blind spot (register #76).
-- The three properties below are the ones a future edit could quietly remove
-- while leaving the function looking correct, so each is asserted in BOTH
-- directions against a fixture whose numbers are the real incident's shape.
--
--   1. DEGRADED is detected at all — a lane still ticking, below the ratio.
--   2. DEGRADED and STOPPED are kept APART. Merging them would make this arm fire
--      on long-retired lanes and read as noise (the #25 permanently-red trap), and
--      `stopped` is already `detect_stalled_pipelines()`'s case.
--   3. ⭐ THE BASELINE EXCLUDES THE RECENT DAYS. This is the property most likely
--      to be "simplified" away, and its removal is SILENT: a trailing baseline
--      that includes the collapse decays toward it, so the ratio climbs back to
--      1.0 and the arm goes quiet while the lane is still broken. The fixture is
--      built so that removing `p_exclude_days` flips the verdict — 2 baseline-window
--      days at 96/day against 3 excluded days at 8/day, where the median over ALL
--      five days is 8 and the median over the baseline window alone is 96.
--
-- Also pinned: the `%-heartbeat` exclusion is REAL and COUNTED (a heartbeat partner
-- mirrors its lane exactly, so including them would double every offender), and the
-- `p_min_baseline` floor keeps daily/weekly lanes out of a rate test that cannot
-- say anything useful about them.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260912054710_audit_20260911_a_silence_detector_cannot_see_a_cadence_collapse.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- ⚠ Fixtures are the two tables the function reads, with only the columns it
-- touches. It reads no catalogs, so no roles are needed. Everything is created and
-- torn down inside a rolled-back transaction.

BEGIN;

CREATE TABLE pipeline_runs_daily (
  pipeline text NOT NULL,
  day      date NOT NULL,
  runs     integer NOT NULL
);

CREATE TABLE pipeline_runs (
  pipeline   text NOT NULL,
  started_at timestamptz NOT NULL
);

-- >>> BEGIN verbatim check_pipeline_cadence_collapse (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.check_pipeline_cadence_collapse(
  p_baseline_days integer DEFAULT 14,
  p_exclude_days  integer DEFAULT 3,
  p_window_hours  integer DEFAULT 12,
  p_ratio         numeric DEFAULT 0.40,
  p_min_baseline  integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  with base as (
    select
      d.pipeline,
      percentile_cont(0.5) within group (order by d.runs)::numeric as baseline_per_day,
      count(*)                                                     as baseline_days_seen
    from public.pipeline_runs_daily d
    where d.day >= current_date - (p_baseline_days + p_exclude_days)
      and d.day <  current_date - p_exclude_days
      and d.pipeline not like '%-heartbeat'
    group by d.pipeline
  ),
  obs as (
    select
      r.pipeline,
      count(*)::numeric * 24.0 / greatest(p_window_hours, 1) as observed_per_day,
      count(*)                                              as observed_runs
    from public.pipeline_runs r
    where r.started_at > now() - make_interval(hours => greatest(p_window_hours, 1))
    group by r.pipeline
  ),
  last_seen as (
    -- R102 (2026-09-18). The published `last_run_at` used to come from `obs`, i.e.
    -- from the OBSERVATION WINDOW, so a lane with zero runs in the last 12 h got a
    -- NULL through the left join and the payload said `"last_run_at": null` for
    -- eight lanes whose last run was plainly readable in pipeline_runs. The field
    -- NAME claims "when did this lane last run"; the value answered a different
    -- question, inside a SAFETY instrument. That is the #80 mirror defect -- an
    -- `unknown` that is actually KNOWN -- and it cost a pass a false "these lanes
    -- never resumed after the outage" reading.
    --
    -- Bounded at 72 h deliberately: pipeline_runs retains ~73 h, so this is the
    -- whole readable history and NOT an unbounded scan of a partitioned table on an
    -- IO-constrained instance. A lane silent longer than that publishes null, which
    -- is then the true answer for this instrument rather than an artifact.
    select r.pipeline, max(r.started_at) as last_run_at
    from public.pipeline_runs r
    where r.started_at > now() - interval '72 hours'
    group by r.pipeline
  ),
  scored as (
    select
      b.pipeline,
      b.baseline_per_day,
      b.baseline_days_seen,
      coalesce(o.observed_per_day, 0) as observed_per_day,
      coalesce(o.observed_runs, 0)    as observed_runs,
      l.last_run_at,
      case when b.baseline_per_day > 0
           then round(coalesce(o.observed_per_day, 0) / b.baseline_per_day, 3)
           else null end              as ratio
    from base b
    left join obs o       on o.pipeline = b.pipeline
    left join last_seen l on l.pipeline = b.pipeline
    where b.baseline_per_day >= p_min_baseline
  ),
  hits as (
    select *,
           case when observed_runs = 0 then 'stopped' else 'degraded' end as state
    from scored
    where observed_per_day < p_ratio * baseline_per_day
  )
  select jsonb_build_object(
    'inspected',           (select count(*) from scored),
    'window',              jsonb_build_object(
                             'baseline_days', p_baseline_days,
                             'exclude_days',  p_exclude_days,
                             'window_hours',  p_window_hours,
                             'ratio',         p_ratio,
                             'min_baseline',  p_min_baseline,
                             'last_run_lookback_hours', 72),
    'baseline_window',     jsonb_build_object(
                             'from', (current_date - (p_baseline_days + p_exclude_days))::text,
                             'to',   (current_date - p_exclude_days)::text),
    'excluded_heartbeats', (select count(distinct d.pipeline) from public.pipeline_runs_daily d
                             where d.day >= current_date - (p_baseline_days + p_exclude_days)
                               and d.day <  current_date - p_exclude_days
                               and d.pipeline like '%-heartbeat'),
    'degraded_count',      (select count(*) from hits where state = 'degraded'),
    'stopped_count',       (select count(*) from hits where state = 'stopped'),
    'degraded',            coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'observed_per_day', h.observed_per_day,
               'observed_runs',    h.observed_runs,
               'ratio',            h.ratio,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end
             ) order by h.ratio)
      from hits h where h.state = 'degraded'), '[]'::jsonb),
    'stopped',             coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end,
               'ran_within_retention', (h.last_run_at is not null)
             ) order by h.pipeline)
      from hits h where h.state = 'stopped'), '[]'::jsonb)
  );
$function$;

-- <<< END verbatim check_pipeline_cadence_collapse <<<

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Baseline window at the defaults is [current_date-17, current_date-3).

-- (1) zz-degraded: 96/day baseline, still ticking at 8/day (ratio 0.083) — the
--     nine-lane incident's exact shape.
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-degraded', current_date - g, 96 FROM generate_series(4, 17) g;
INSERT INTO pipeline_runs (pipeline, started_at)
SELECT 'zz-degraded', now() - make_interval(hours => h) FROM generate_series(1, 4) h;

-- (2) zz-healthy: same baseline, still at full rate (48 runs in 12 h = 96/day).
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-healthy', current_date - g, 96 FROM generate_series(4, 17) g;
INSERT INTO pipeline_runs (pipeline, started_at)
SELECT 'zz-healthy', now() - make_interval(mins => 15 * m) FROM generate_series(1, 48) m;

-- (3) zz-stopped: same baseline, ZERO runs in the window.
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-stopped', current_date - g, 96 FROM generate_series(4, 17) g;

-- (4) zz-degraded-heartbeat: collapsed exactly like (1) but a heartbeat partner.
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-degraded-heartbeat', current_date - g, 96 FROM generate_series(4, 17) g;
INSERT INTO pipeline_runs (pipeline, started_at)
SELECT 'zz-degraded-heartbeat', now() - make_interval(hours => h) FROM generate_series(1, 4) h;

-- (5) zz-slow: a 12/day lane, fully stopped — below p_min_baseline, so a rate test
--     has nothing to say about it and it must NOT appear.
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-slow', current_date - g, 12 FROM generate_series(4, 17) g;

-- (6) zz-poisoned: only TWO days inside the baseline window (96/day), and THREE
--     excluded days already collapsed (8/day). Median over all five days is 8;
--     median over the baseline window alone is 96. So this row flags ONLY if the
--     exclusion is honoured.
INSERT INTO pipeline_runs_daily (pipeline, day, runs) VALUES
  ('zz-poisoned', current_date - 4, 96),
  ('zz-poisoned', current_date - 5, 96),
  ('zz-poisoned', current_date - 1, 8),
  ('zz-poisoned', current_date - 2, 8),
  ('zz-poisoned', current_date - 3, 8);
INSERT INTO pipeline_runs (pipeline, started_at)
SELECT 'zz-poisoned', now() - make_interval(hours => h) FROM generate_series(1, 4) h;

-- (7) zz-paused: same 96/day baseline, ZERO runs in the 12 h window, but ONE run
--     20 h ago -- i.e. plainly readable in pipeline_runs. Added 2026-09-18 for
--     R102. Before the fix this row published `"last_run_at": null`, an `unknown`
--     that was actually KNOWN, inside a safety instrument; eight live lanes read
--     that way at once and a pass nearly filed a false P0 off it.
INSERT INTO pipeline_runs_daily (pipeline, day, runs)
SELECT 'zz-paused', current_date - g, 96 FROM generate_series(4, 17) g;
INSERT INTO pipeline_runs (pipeline, started_at)
VALUES ('zz-paused', now() - interval '20 hours');

-- ── Assertions ──────────────────────────────────────────────────────────────

-- Non-vacuity FIRST: a guard that inspected nothing would satisfy every assertion
-- below about absence. Four lanes clear p_min_baseline (zz-slow and the heartbeat
-- partner do not).
SELECT _assert_eq((check_pipeline_cadence_collapse()->>'inspected'), '5',
  'inspected the five lanes whose baseline clears p_min_baseline');

-- (1) the degraded lane is found, with its ratio
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-degraded'), '1',
  'a lane still ticking at 8/day against a 96/day baseline is DEGRADED');
SELECT _assert_eq((SELECT e->>'ratio' FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-degraded'), '0.083',
  'the published ratio is observed/baseline, not a rank');

-- (2) the healthy lane is absent from BOTH lists — the other direction
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-healthy'), '0',
  'a lane at full cadence is NOT degraded');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-healthy'), '0',
  'a lane at full cadence is NOT stopped either');

-- (3) the split: stopped is stopped, and is NOT reported as degraded
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-stopped'), '1',
  'a lane with zero runs in the window is STOPPED');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-stopped'), '0',
  'a STOPPED lane must not also be reported as degraded — they need opposite responses');
SELECT _assert_eq((check_pipeline_cadence_collapse()->>'degraded_count'), '2',
  'exactly two degraded: zz-degraded and zz-poisoned');
SELECT _assert_eq((check_pipeline_cadence_collapse()->>'stopped_count'), '2',
  'exactly two stopped: zz-stopped (no readable history) and zz-paused (ran 20 h ago)');

-- (4) the heartbeat exclusion is real AND counted
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' LIKE '%-heartbeat'), '0',
  'a heartbeat partner is excluded rather than doubling its lane');
SELECT _assert((check_pipeline_cadence_collapse()->>'excluded_heartbeats')::int >= 1,
  'the heartbeat exclusion is PUBLISHED, not silent');

-- (5) the p_min_baseline floor keeps a 12/day lane out even though it is dead
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-slow'), '0',
  'a 12/day lane is below p_min_baseline and cannot be rate-tested');

-- (6) ⭐ THE BASELINE EXCLUSION. Flagged at the default exclude_days=3, because the
--     baseline is read from the two pre-collapse days (96/day). Remove the
--     exclusion (exclude_days=0) and the median becomes 8/day, the ratio becomes
--     1.0, and the lane disappears — which is the silent failure this asserts.
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-poisoned'), '1',
  'with the recent days EXCLUDED, the pre-collapse baseline is used and the lane flags');
SELECT _assert_eq((SELECT count(*)::text FROM jsonb_array_elements(check_pipeline_cadence_collapse(14, 0, 12, 0.40, 24)->'degraded') e
                    WHERE e->>'pipeline' = 'zz-poisoned'), '0',
  'with exclude_days=0 the collapse poisons its own baseline and the lane goes QUIET — the property being pinned');

-- Threshold sanity in both directions, so the ratio parameter is not inert.
SELECT _assert_eq((check_pipeline_cadence_collapse(14, 3, 12, 0.0, 24)->>'degraded_count'), '0',
  'at ratio 0 nothing can flag — satisfiable at a population of zero');
SELECT _assert((check_pipeline_cadence_collapse(14, 3, 12, 1.0, 24)->>'degraded_count')::int >= 2,
  'at ratio 1.0 the predicate responds — the threshold is not inert');

SELECT '✓ check_pipeline_cadence_collapse invariants pass' AS result;

-- ── (7) R102: `last_run_at` is the lane's TRUE last run, not its last run inside
--     the observation window ───────────────────────────────────────────────────
-- The field NAME asks "when did this lane last run". Until 2026-09-18 the value
-- came from the observation-window CTE, so it answered "when did it last run in
-- the last 12 h" -- and those differ EXACTLY when the arm fires, which is the only
-- time anyone reads it. Both directions are asserted, because a fix that simply
-- always published a timestamp would be the mirror defect.

SELECT _assert_eq((SELECT (e->>'last_run_at') IS NOT NULL FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-paused')::text, 'true',
  'a lane with no runs in the window but a readable run 20 h ago publishes that timestamp, not null');
SELECT _assert_eq((SELECT e->>'ran_within_retention' FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-paused'), 'true',
  'and says so explicitly -- this is the discriminator between paused and no-history');
SELECT _assert_eq((SELECT round((e->>'hours_since_last_run')::numeric) FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-paused')::text, '20',
  'hours_since_last_run is derived from the true last run, so it is readable without a second query');

-- NO-CHANGE CONTROL, and it is the whole reason the arm above is safe: a lane with
-- NO readable history must STILL publish null. Without this, "always emit a
-- timestamp" satisfies every assertion above and manufactures a freshness claim for
-- a lane nobody can date -- the fabricated-value shape, one level down.
SELECT _assert_eq((SELECT (e->>'last_run_at') IS NULL FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-stopped')::text, 'true',
  'NO-CHANGE CONTROL: a lane with no runs at all in retention still publishes null');
SELECT _assert_eq((SELECT e->>'ran_within_retention' FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'stopped') e
                    WHERE e->>'pipeline' = 'zz-stopped'), 'false',
  'NO-CHANGE CONTROL: and reports ran_within_retention false rather than omitting the field');

-- The lookback bound is part of the claim, not an implementation detail: null means
-- "silent longer than the readable history", and a reader cannot interpret that
-- without knowing how long that is.
SELECT _assert_eq((check_pipeline_cadence_collapse()->'window'->>'last_run_lookback_hours'), '72',
  'the payload states the lookback its nulls are relative to');

-- A degraded lane also carries the true last run and its numerator.
SELECT _assert_eq((SELECT (e->>'last_run_at') IS NOT NULL FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-degraded')::text, 'true',
  'degraded rows carry last_run_at too');
SELECT _assert_eq((SELECT e->>'observed_runs' FROM jsonb_array_elements(check_pipeline_cadence_collapse()->'degraded') e
                    WHERE e->>'pipeline' = 'zz-degraded'), '4',
  'and observed_runs, so the published ratio can be checked against its numerator');

ROLLBACK;
