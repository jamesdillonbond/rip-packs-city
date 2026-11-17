-- 2026-11-17 (Claude Code, Trevor's laptop, ~3:05 PM PT; Trevor: "Keep going and doing what you can").
--
-- A FAILED Panini team walk went to the BACK of the rotation. panini_team_walk_plan_for orders by
-- last_attempt_at, and the receiver stamps last_attempt_at on every walk, complete or not — so a
-- walk that stopped at a flaky page (complete=false, nothing retired) waited a full cycle (~23 days)
-- before its next try. Measured 11-17 ~3:00 PM PT: 9 of 108 enabled targets last ended on a failed
-- walk; 5 NFL teams (Denver, Indianapolis, Pittsburgh, Seattle, Washington, first attempted
-- 10-29 → 11-09) have NEVER completed and none was retried; Oklahoma City last completed 10-22 (failed
-- 11-15, next due ~12-08); 11-17's three failures (Arizona Cardinals, Atlanta, Atlanta Falcons) would
-- not have been retried until ~12-10.
--
-- NOW: the staleness key is greatest(last_complete_at, last_attempt_at - 21 days). A completed walk
-- keys on its completion (unchanged order for every healthy target); a failed attempt buys only
-- ~2 days of freshness against a ~23-day cycle, so the team heads the plan again within ~2 nights.
-- A target that fails every time recurs about every other night (one slot of ~5) — visible as
-- repeated ok=false rows — instead of silently dropping out of the rotation. The never-attempted tier
-- and the cross-sport interleave (20261023145800) are unchanged.
--
-- Simulated before apply: head of the new order = the 5 never-completed NFL teams, then the 10-25
-- completions with Oklahoma City among them.
--
-- Read back after apply (20261117230420): anon EXECUTE false, service_role true; plan(8) = Denver Broncos,
-- Indianapolis Colts, Pittsburgh Steelers, Seattle Seahawks, Washington Commanders, Baltimore Ravens, Boston, Buffalo Bills.
--
-- Revert: re-apply panini_team_walk_plan_for from 20261023145800.

-- anon-exec: unchanged (panini_team_walk_plan_for) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false authenticated=false.
CREATE OR REPLACE FUNCTION public.panini_team_walk_plan_for(p_limit integer, p_sports text[])
 RETURNS TABLE(sport text, team text, last_complete_at timestamp with time zone, last_attempt_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH eligible AS (
    SELECT t.sport, t.team, t.last_complete_at, t.last_attempt_at,
           (t.last_attempt_at IS NULL) AS never,
           greatest(t.last_complete_at, t.last_attempt_at - interval '21 days') AS stale_key,
           row_number() OVER (PARTITION BY t.sport, (t.last_attempt_at IS NULL)
                              ORDER BY greatest(t.last_complete_at, t.last_attempt_at - interval '21 days') ASC NULLS FIRST, t.team) AS sport_rank
    FROM panini_team_walk_targets t
    WHERE t.enabled
      AND t.sport = ANY (COALESCE(p_sports, ARRAY['Basketball','Baseball']))
  )
  SELECT e.sport, e.team, e.last_complete_at, e.last_attempt_at
  FROM eligible e
  ORDER BY e.never DESC,
           CASE WHEN e.never THEN e.sport_rank END ASC NULLS LAST,
           e.stale_key ASC NULLS FIRST,
           e.sport, e.team
  LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$function$;
