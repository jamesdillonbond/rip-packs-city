-- audit_20261026: get_panini_player_teams counts SINGLE-player cards only (Cowork cloud, 2026-10-26 ~3:31 AM PT).
-- A two-player card ("A | B") carries BOTH players' franchise keys and cannot say which is whose: the first version
-- (20261026103129) put one Dallas Wings card on Caitlin Clark (the Clark | Paige Bueckers card). Measured after:
-- Clark → Indiana Fever 85; LeBron → Lakers 206 · Cavaliers 8 · Heat 4; Lillard → Blazers 85 · Bucks 44; Brady →
-- Buccaneers 33 · Patriots 13; Messi → [] (soccer has no franchise). ~83 ms (a panini_editions scan), read by the
-- Panini player page (lib/panini/player-teams.ts). The franchise hubs and edition-page chip still show a two-player
-- card under both teams — correct there, the card pictures both players.
-- Revert: re-apply 20261026103129, or drop the function and git revert the page change.

-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL set in 20261026103129 (postgres + service_role) (get_panini_player_teams)

CREATE OR REPLACE FUNCTION public.get_panini_player_teams(p_name text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The franchises RPC's Panini team map (panini_edition_team_keys) places a player's catalogued cards on,
  -- most cards first. SINGLE-player cards only: a two-player card ("A | B") carries both players' teams and
  -- cannot say which is whose (Caitlin Clark | Paige Bueckers read as a Clark Wings card). [] = none placed.
  WITH ed AS (
    SELECT pe.external_id
      FROM public.panini_editions pe
     WHERE nullif(btrim(p_name), '') IS NOT NULL
       AND pe.player_name = btrim(p_name)
  ), k AS (
    SELECT key, count(*)::int AS editions
      FROM ed JOIN public.panini_edition_team_keys t ON t.external_id = ed.external_id
     CROSS JOIN LATERAL unnest(t.franchise_keys) AS key
     GROUP BY key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('league', tm.league::text, 'slug', tm.slug, 'team_name', tm.team_name, 'editions', k.editions)
                            ORDER BY k.editions DESC, tm.team_name), '[]'::jsonb)
    FROM k
    JOIN public.teams_master tm ON tm.league::text = split_part(k.key, ':', 1) AND tm.slug = split_part(k.key, ':', 2) AND tm.active;
$function$;
