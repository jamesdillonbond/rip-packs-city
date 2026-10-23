-- The team-walk plan rotates ACROSS sports (2026-10-23; follows 20261023135645).
--
-- WHY. panini_team_walk_plan_for orders by last_attempt_at NULLS FIRST, then
-- sport, team — so the 26 never-walked Baseball rows sort ahead of every
-- never-walked Football / Womens Basketball row ('Baseball' < 'Football'), and a
-- walker that CAN walk NFL (the post-10-23 laptop script) would still spend ~5
-- nights (5 targets a night) on baseball before its first NFL team. It also
-- hides whether the laptop pulled the new script: old and new would walk the
-- same 5 baseball cities.
--
-- NOW. Within the stalest tier, targets interleave by sport: each row's rank
-- among its own sport's targets (same staleness order) comes before the sport
-- name. Never-walked rows: Baseball #1, Football #1, Womens Basketball #1,
-- Baseball #2, … A walker naming only Basketball/Baseball (the old script)
-- gets exactly what it got before (Basketball rows are all walked, so Baseball
-- still leads). Staleness still dominates: an attempted row never jumps a
-- never-attempted one.
--
-- Revert: re-apply panini_team_walk_plan_for from 20261023132830.

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
           row_number() OVER (PARTITION BY t.sport, (t.last_attempt_at IS NULL)
                              ORDER BY t.last_attempt_at ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.team) AS sport_rank
    FROM panini_team_walk_targets t
    WHERE t.enabled
      AND t.sport = ANY (COALESCE(p_sports, ARRAY['Basketball','Baseball']))
  )
  SELECT e.sport, e.team, e.last_complete_at, e.last_attempt_at
  FROM eligible e
  ORDER BY e.never DESC,
           CASE WHEN e.never THEN e.sport_rank END ASC NULLS LAST,
           e.last_attempt_at ASC NULLS FIRST, e.last_complete_at ASC NULLS FIRST,
           e.sport, e.team
  LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$function$;
