-- audit_20260914: check_wall_kills() reports CLEAN RUNS SINCE THE LAST KILL, so a
-- finished incident stops reading as a live one.
--
-- WHY. Measured 2026-09-14 07:3x AM PT, the arm was WARNing on five pipelines:
--   fmv-recalc 28/149 (last kill 09-13 21:28Z) · drain-fmv-cold-tail 5/48 (18:47Z)
--   wmc-fmv-populate 3/293 (19:33Z) · sentinel 2/30 (18:17Z) · panini-ingest 1/796 (17:12Z)
-- ⭐ EVERY last_kill_at falls inside a 4h16m band on 09-13 (17:12Z-21:28Z = 10:12 AM
--    - 2:28 PM PT) -- the documented IO-saturation spell. There had been ZERO kills
--    in the ~17 hours since, across hundreds of heartbeats per lane.
--
-- So the arm had been amber for 17 hours on a 4-hour incident that was over. That is
-- this module's OWN lesson, unapplied to itself: lib/sentinel/wall-kills.ts states
-- that "a POOLED rate over a window cannot distinguish 'broken now' from 'was broken,
-- then fixed, and the window still carries the corpse'" -- and then hands that
-- discrimination to "a reader". ⛔ THERE IS NO READER. The sentinel renders a WARN
-- list; a human is not going to re-derive five last_kill_at values against each
-- lane's cadence. An arm that needs a human to apply a discrimination the machine
-- already has the data for is the permanently-amber instrument CLAUDE.md warns about
-- -- indistinguishable from a broken one.
--
-- WHAT CHANGES, AND IT IS ONE ADDITIVE FIELD: `clean_since_last_kill` per offender.
-- ⭐ WHY THAT FIELD AND NOT "HOURS SINCE": hours is a PROXY that coincides today.
--    The property is "has this lane had chances to fail again and taken none", and
--    the unit for that is RUNS, not time -- a lane at 7 ticks/day and one at 796
--    are not comparable on a clock. CLAUDE.md: a control's population must be the
--    set the property is true of, never a proxy. dead-lane-backstop (7/24h) is
--    exactly the lane a time-based rule would clear on no evidence.
-- ⭐ Every marker after the last kill is MATCHED BY CONSTRUCTION (last_kill_at is
--    the MAX unmatched), so this count IS "consecutive clean runs since the kill".
--    No second correlation pass is needed and none is done.
--
-- COST: computed from the already-MATERIALIZED `scored` CTE (~1,300 marker rows),
-- so there is NO additional access to pipeline_runs. The arm's ~33,000-buffer
-- probe cost (lib/sentinel/probe-cost.ts) is unchanged -- this reads a CTE that
-- was already built, which is why `scored` keeping MATERIALIZED matters.
--
-- ⚠ THE VERDICT CHANGE LIVES IN TS (lib/sentinel/wall-kills.ts) AND FAILS CLOSED:
--    an offender whose `clean_since_last_kill` is absent or unreadable is treated as
--    LIVE, so an older SQL body that does not return the field keeps warning rather
--    than going green. A missing read must never render as a clean answer.
--
-- ⛔ NOT CHANGED: the marker rules, the ±5 s correlation, the grace window, the
--    `unverified` rule, and the fact that this arm WARNS and never pages.
--
-- REVERT: re-apply 20260913-era body (drop the per0/per split and the two new keys);
--         the TS half reverts with `git revert <sha>` of the same commit.
CREATE OR REPLACE FUNCTION public.check_wall_kills(p_window interval DEFAULT '24:00:00'::interval, p_grace interval DEFAULT '00:10:00'::interval)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH raw AS MATERIALIZED (
    SELECT pipeline, started_at
    FROM public.pipeline_runs
    WHERE started_at > now() - p_window
      AND started_at < now() - p_grace
      AND (pipeline LIKE '%-heartbeat' OR pipeline LIKE '%-dispatch')
  ), markers AS (
    SELECT left(pipeline, length(pipeline) - 10) AS base,
           left(pipeline, length(pipeline) - 10) AS terminal,
           started_at
    FROM raw WHERE pipeline LIKE '%-heartbeat'
    UNION ALL
    -- A `-dispatch` name is a marker ONLY when its `-complete` sibling exists
    -- (alerts-dispatch is a real pipeline). Derived from the data, never a list.
    SELECT left(pipeline, length(pipeline) - 9),
           left(pipeline, length(pipeline) - 9) || '-complete',
           started_at
    FROM raw r WHERE pipeline LIKE '%-dispatch'
      AND EXISTS (SELECT 1 FROM public.pipeline_runs c
                  WHERE c.pipeline = left(r.pipeline, length(r.pipeline) - 9) || '-complete'
                    AND c.started_at > now() - p_window)
  ), scored AS MATERIALIZED (
    SELECT m.base, m.started_at,
           EXISTS (SELECT 1 FROM public.pipeline_runs t
                   WHERE t.pipeline = m.terminal
                     AND t.started_at BETWEEN m.started_at - interval '5 seconds'
                                          AND m.started_at + interval '5 seconds') AS matched
    FROM markers m
  ), per0 AS (
    SELECT base,
           count(*)                                   AS heartbeats,
           count(*) FILTER (WHERE matched)            AS matched,
           count(*) FILTER (WHERE NOT matched)        AS kills,
           max(started_at) FILTER (WHERE NOT matched) AS last_kill_at
    FROM scored GROUP BY base
  ), per AS (
    -- CLEAN RUNS SINCE THE LAST KILL. Read from `scored` (already materialized
    -- above), so this adds no access to pipeline_runs. Every marker later than
    -- last_kill_at is matched by construction, because last_kill_at is the MAX
    -- unmatched one -- so this count is exactly the run of clean ticks since.
    SELECT p.base, p.heartbeats, p.matched, p.kills, p.last_kill_at,
           (SELECT count(*) FROM scored s
             WHERE s.base = p.base AND s.started_at > p.last_kill_at) AS clean_since_last_kill
    FROM per0 p
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object(
       'hours', round((extract(epoch FROM p_window) / 3600)::numeric, 1),
       'grace_minutes', round((extract(epoch FROM p_grace) / 60)::numeric, 1),
       'correlation_seconds', 5),
    'inspected', (SELECT count(*) FROM per),
    'verified',  (SELECT count(*) FROM per WHERE matched > 0),
    'unverified', COALESCE((SELECT jsonb_agg(jsonb_build_object('pipeline', base, 'heartbeats', heartbeats) ORDER BY heartbeats DESC, base)
                            FROM per WHERE matched = 0), '[]'::jsonb),
    'offenders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                              'pipeline', base, 'heartbeats', heartbeats, 'kills', kills,
                              'kill_pct', round(100.0 * kills / heartbeats, 1), 'last_kill_at', last_kill_at,
                              'clean_since_last_kill', clean_since_last_kill)
                            ORDER BY kills DESC, base)
                           FROM per WHERE matched > 0 AND kills > 0), '[]'::jsonb)
  );
$function$;

-- anon-exec: intentional — SNAPSHOT of an existing arm (check_wall_kills), not a new
-- function. CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would
-- CHANGE production rather than preserve it. The sentinel route reads it via PostgREST.
