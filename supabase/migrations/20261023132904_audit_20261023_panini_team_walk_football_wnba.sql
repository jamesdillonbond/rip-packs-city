-- Panini team walk: Football (NFL) and Womens Basketball (WNBA) (2026-10-23).
-- Part 2 of 2 — follows 20261023132830.
--
-- Widens the three sport CHECKs (roster, listings, aliases) from
-- Basketball/Baseball to the four sports the franchise hubs cover, then puts
-- every current NFL and WNBA franchise on the roster under its teams_master
-- name (32 + 15), plus four historic NFL labels Panini's 2021+ products may
-- still file cards under (Washington Football Team, Oakland Raiders, San Diego
-- Chargers, St. Louis Rams). The sport values are the ones Panini's grid URL
-- takes (the soccer runner walks sport=Football / sport=Womens%20Basketball).
--
-- ⚠ The team labels are teams_master's spelling, NOT read from Panini (its
-- marketplace is unreachable from the session that wrote this). For the NBA
-- that spelling matched 24 of 30 with no alias. A label Panini spells
-- differently walks an empty grid: last_listings = 0 on the roster row is the
-- tell, and the fix is a roster row in Panini's spelling (the resolver already
-- maps every current and historic name through league_team_abbr).
--
-- Safe against the laptop's CURRENT script: /api/cron/panini-team-walk plans
-- through panini_team_walk_plan_for with ['Basketball','Baseball'] unless the
-- walker names its sports, so these rows are only handed to a walker that can
-- walk them.
--
-- Revert: delete the roster rows (sport IN ('Football','Womens Basketball'));
--   restore each CHECK to sport = ANY (ARRAY['Basketball','Baseball']) once no
--   row uses another sport.

ALTER TABLE public.panini_team_walk_targets
  DROP CONSTRAINT panini_team_walk_targets_sport_check,
  ADD CONSTRAINT panini_team_walk_targets_sport_check
    CHECK (sport = ANY (ARRAY['Basketball'::text, 'Baseball'::text, 'Football'::text, 'Womens Basketball'::text]));
ALTER TABLE public.panini_team_listings
  DROP CONSTRAINT panini_team_listings_sport_check,
  ADD CONSTRAINT panini_team_listings_sport_check
    CHECK (sport = ANY (ARRAY['Basketball'::text, 'Baseball'::text, 'Football'::text, 'Womens Basketball'::text]));
ALTER TABLE public.panini_team_aliases
  DROP CONSTRAINT panini_team_aliases_sport_check,
  ADD CONSTRAINT panini_team_aliases_sport_check
    CHECK (sport = ANY (ARRAY['Basketball'::text, 'Baseball'::text, 'Football'::text, 'Womens Basketball'::text]));

INSERT INTO public.panini_team_walk_targets (sport, team, enabled)
SELECT CASE tm.league::text WHEN 'NFL' THEN 'Football' ELSE 'Womens Basketball' END, tm.team_name, true
FROM public.teams_master tm
WHERE tm.active AND tm.league::text IN ('NFL', 'WNBA')
UNION ALL
SELECT 'Football', x, true
FROM unnest(ARRAY['Washington Football Team', 'Oakland Raiders', 'San Diego Chargers', 'St. Louis Rams']) AS x
ON CONFLICT (sport, team) DO NOTHING;
