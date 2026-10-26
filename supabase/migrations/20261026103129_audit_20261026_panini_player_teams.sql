-- audit_20261026: get_panini_player_teams(p_name) — the franchises RPC's Panini team map places a player's cards on
-- (Cowork cloud, 2026-10-26 ~3:30 AM PT; Top Shot parity: the player page names the team). FIRST VERSION, superseded
-- within a minute by 20261026103150, which counts SINGLE-player cards only (this one also counted "A | B" cards and so
-- put one Dallas Wings card on Caitlin Clark — the Clark | Bueckers card). Kept verbatim as applied.
-- Revert: superseded; see 20261026103150.

-- anon-exec: revoked (get_panini_player_teams) — new reader; REVOKE FROM PUBLIC, anon, authenticated below.

CREATE OR REPLACE FUNCTION public.get_panini_player_teams(p_name text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The franchises RPC's Panini team map (panini_edition_team_keys) places a player's catalogued cards on,
  -- most cards first. A two-player card ("A | B") counts for each named player. [] = none placed (not "no team").
  WITH ed AS (
    SELECT pe.external_id
      FROM public.panini_editions pe
     WHERE nullif(btrim(p_name), '') IS NOT NULL
       AND (pe.player_name = btrim(p_name) OR btrim(p_name) = ANY (string_to_array(pe.player_name, ' | ')))
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

REVOKE EXECUTE ON FUNCTION public.get_panini_player_teams(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_player_teams(text) TO postgres, service_role;
