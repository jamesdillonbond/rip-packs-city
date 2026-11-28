-- audit_20261127_top_collector_census_map_text_keys
--
-- Fix to 20261128020000: editions.external_id (and the address columns) are varchar, and RETURN QUERY
-- needs the declared text columns exactly, so the Flow branch of top_collector_census_map raised 42804
-- ("Returned type character varying does not match expected type text") on its first call (6:10 PM PT).
-- Explicit ::text casts; the logic is unchanged.
--
-- Revert: re-apply top_collector_census_map from 20261128020000 (which raises on Flow collections).

CREATE OR REPLACE FUNCTION public.top_collector_census_map(p_collection_id uuid)
RETURNS TABLE (ek text, kind text, key text, fmv numeric, circ integer, jersey integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
BEGIN
  SELECT c.slug INTO v_slug FROM collections c WHERE c.id = p_collection_id;
  IF v_slug IS NULL OR v_slug NOT IN ('nba_top_shot', 'nfl_all_day', 'laliga_golazos', 'disney_pinnacle') THEN
    RAISE EXCEPTION 'top_collector_census_map: no census for collection %', p_collection_id;
  END IF;

  IF v_slug = 'disney_pinnacle' THEN
    RETURN QUERY
    SELECT pc.render_id::text, k.kind, k.key, pc.fmv_usd::numeric, NULL::integer, NULL::integer
      FROM pinnacle_catalog pc
     CROSS JOIN LATERAL (
       SELECT DISTINCT kk.kind, kk.key FROM (
         SELECT 'player'::text AS kind, lower(btrim(c)) AS key FROM unnest(pc.characters) c
         UNION ALL
         SELECT 'player', lower(array_to_string(pc.characters, ' & ')) WHERE cardinality(pc.characters) > 1
         UNION ALL
         SELECT 'player', lower(array_to_string(pc.characters, ' ')) WHERE cardinality(pc.characters) > 1
         UNION ALL
         SELECT 'team', regexp_replace(lower(btrim(regexp_replace(fr, '[™®©]', '', 'g'))), '[^a-z0-9]+', '-', 'g')
           FROM unnest(pc.franchises) fr
          WHERE btrim(regexp_replace(fr, '[™®©]', '', 'g')) <> ''
       ) kk WHERE kk.key IS NOT NULL AND kk.key <> ''
     ) k
     WHERE pc.render_id IS NOT NULL;
    RETURN QUERY
    SELECT ''::text, 'exclude'::text, lower(x.addr)::text, NULL::numeric, NULL::integer, NULL::integer
      FROM (SELECT address AS addr FROM flowty_excluded_addresses
            UNION SELECT DISTINCT m.owner FROM mv_pinnacle_render_owners m WHERE m.is_system) x
     WHERE x.addr IS NOT NULL;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT (CASE WHEN v_slug = 'nba_top_shot'
              THEN CASE WHEN e.external_id LIKE '%::%' THEN replace(e.external_id, '::', ':') ELSE e.external_id || ':0' END
              ELSE e.external_id END)::text,
         k.kind, k.key,
         (SELECT ef.fmv_usd FROM edition_fmv_current ef WHERE ef.edition_id = e.id LIMIT 1)::numeric,
         e.circulation_count::integer, e.jersey_number::integer
    FROM editions e
   CROSS JOIN LATERAL (
     SELECT 'player'::text AS kind, coalesce(e.player_id::text, 'name:' || e.player_name)::text AS key
      WHERE e.player_id IS NOT NULL OR e.player_name IS NOT NULL
     UNION ALL
     SELECT 'team', regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g')::text
      WHERE e.team_name IS NOT NULL AND trim(e.team_name) <> ''
   ) k
   WHERE e.collection_id = p_collection_id AND e.external_id IS NOT NULL;
  RETURN QUERY
  SELECT ''::text, 'exclude'::text, lower(xa.address)::text, NULL::numeric, NULL::integer, NULL::integer
    FROM flowty_excluded_addresses xa WHERE xa.address IS NOT NULL;
END;
$$;
-- anon-exec: unchanged (top_collector_census_map) — CREATE OR REPLACE of the function created in 20261128020000; ACL preserved.
