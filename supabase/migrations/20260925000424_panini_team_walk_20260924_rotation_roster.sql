-- Panini team walk — ROTATION roster (2026-09-24, Trevor: "do it").
--
-- The walk moves out of the soccer runner into its own daily Windows task and walks
-- the STALEST few teams each run instead of a fixed list: 30 NBA teams + Detroit (the
-- MLB pilot) at 5 a day refreshes every team about once a week. Panini's Cloudflare
-- 429-throttled the first laptop run, so a week's freshness is deliberately the target
-- — nothing on the site reads these listings yet.
--
--   panini_team_walk_targets — the roster, keyed by Panini's own `team` string (the
--     grid filter value): NBA teams_master names, except the Clippers, which Panini
--     spells "Los Angeles Clippers" (panini_team_aliases).
--   panini_team_walk_plan(n) — the n enabled targets, least recently ATTEMPTED first
--     (never-attempted at the head), then oldest last_complete_at. Ordering on the
--     attempt, not the completion, is deliberate: a team whose walk keeps failing
--     would otherwise sit at the head of every run and starve the rest of the roster.
--     It comes round again after one full cycle; its failures stay visible in
--     pipeline_runs (panini-team-walk ok=false).
--   panini_team_walk_note(sport, team, ok, listings) — called by
--     /api/cron/panini-team-walk: every call stamps last_attempt_at; ok=true also
--     stamps last_complete_at. ok is the walker's own verdict (list ended on an empty
--     page AND every write landed), so a partial walk never counts as fresh.
--
-- last_complete_at is seeded from the two complete walks already in
-- panini_team_listings (Blazers, Detroit — 2026-09-24 ~4 PM PT) so they go to the back.
--
-- Revert: DROP FUNCTION public.panini_team_walk_note(text, text, boolean, integer);
-- DROP FUNCTION public.panini_team_walk_plan(integer); DROP TABLE public.panini_team_walk_targets;

CREATE TABLE IF NOT EXISTS public.panini_team_walk_targets (
  sport            text NOT NULL CHECK (sport IN ('Basketball','Baseball')),
  team             text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  last_attempt_at  timestamptz,
  last_complete_at timestamptz,
  last_listings    integer,
  PRIMARY KEY (sport, team)
);
COMMENT ON TABLE public.panini_team_walk_targets IS
  'Roster for scripts/panini-team-walk.mjs rotation mode, keyed by Panini''s grid `team` filter value. Maintained by panini_team_walk_note via /api/cron/panini-team-walk; read by panini_team_walk_plan. Staging only — see docs/features/franchise-hubs.md.';
ALTER TABLE public.panini_team_walk_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_team_walk_targets FROM anon, authenticated;

INSERT INTO public.panini_team_walk_targets (sport, team)
SELECT 'Basketball',
       COALESCE((SELECT a.raw_team FROM public.panini_team_aliases a
                  WHERE a.sport = 'Basketball' AND a.league = 'NBA' AND a.team_slug = tm.slug
                    AND a.note LIKE 'Panini spelling%'
                  LIMIT 1), tm.team_name)
FROM public.teams_master tm
WHERE tm.league = 'NBA' AND tm.active
ON CONFLICT (sport, team) DO NOTHING;

INSERT INTO public.panini_team_walk_targets (sport, team) VALUES ('Baseball', 'Detroit')
ON CONFLICT (sport, team) DO NOTHING;

UPDATE public.panini_team_walk_targets t
   SET last_complete_at = s.last_seen, last_attempt_at = s.last_seen, last_listings = s.n
  FROM (SELECT sport, walk_team, max(last_seen_at) AS last_seen, count(*) FILTER (WHERE active)::int AS n
          FROM public.panini_team_listings GROUP BY sport, walk_team) s
 WHERE s.sport = t.sport AND s.walk_team = t.team AND t.last_complete_at IS NULL;

CREATE OR REPLACE FUNCTION public.panini_team_walk_plan(p_limit integer)
 RETURNS TABLE(sport text, team text, last_complete_at timestamptz, last_attempt_at timestamptz)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT t.sport, t.team, t.last_complete_at, t.last_attempt_at
  FROM panini_team_walk_targets t
  WHERE t.enabled
  ORDER BY t.last_attempt_at ASC NULLS FIRST, t.last_complete_at ASC NULLS FIRST, t.sport, t.team
  LIMIT greatest(1, least(coalesce(p_limit, 5), 50));
$function$;
REVOKE ALL ON FUNCTION public.panini_team_walk_plan(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_team_walk_plan(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.panini_team_walk_note(p_sport text, p_team text, p_ok boolean, p_listings integer)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  WITH u AS (
    UPDATE panini_team_walk_targets t
       SET last_attempt_at  = now(),
           last_complete_at = CASE WHEN p_ok IS TRUE THEN now() ELSE t.last_complete_at END,
           last_listings    = CASE WHEN p_ok IS TRUE THEN p_listings ELSE t.last_listings END
     WHERE t.sport = p_sport AND t.team = p_team
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$function$;
REVOKE ALL ON FUNCTION public.panini_team_walk_note(text, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_team_walk_note(text, text, boolean, integer) TO service_role;