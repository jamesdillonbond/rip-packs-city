-- audit_20260927_pinnacle_character_mint_dates_only_when_complete
--
-- WHY. A Disney Pinnacle character page printed "First minted … · Last minted …"
-- from MIN/MAX(pinnacle_editions.minting_date). Measured 2026-09-27: 83 of the
-- table's 594 rows carry a minting_date; of 250 characters, 179 have none, 48
-- have SOME and 23 have all. For the 48 the span was computed from the dated
-- few and published as the character's span — Mickey Mouse read first = last
-- = 2026-01-27 from 1 of 24 rows, while his pins run Series 2023–2026. A
-- partial read rendered as a fact (CLAUDE.md, Honesty).
--
-- WHAT. Both Pinnacle arms return the dates only when EVERY matching row has
-- one; otherwise NULL, which the page renders as no line at all. The sports
-- arm is unchanged. Base: the live body, byte-identical to 20260926191644
-- (prosrc md5 d4f71596399663460dff957ea4f10689, re-read before this migration).
--
-- anon-exec: unchanged (get_player_detail) — CREATE OR REPLACE keeps the ACL.
--
-- Revert: re-apply the get_player_detail block from
-- 20260926191644_audit_20260926_pinnacle_duo_character_pages_find_their_pins.sql.

CREATE OR REPLACE FUNCTION public.get_player_detail(p_collection_id uuid, p_player_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_player           RECORD;
  v_collection_slug  text;
  v_edition_count    int;
  v_total_circulation int;
  v_fmv_total        numeric;
  v_floor_total      numeric;
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR e.player_name = p.name)
           AND e.team_name IS NOT DISTINCT FROM p.team) AS team_edition_count
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  ),
  recent AS (
    SELECT e.team_name, e.game_date
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.player_name = (SELECT min(name) FROM cand)
      AND e.team_name IS NOT NULL
      AND e.game_date IS NOT NULL
    ORDER BY e.game_date DESC
    LIMIT 1
  ),
  horizon AS (
    SELECT max(game_date) AS max_gd
    FROM editions
    WHERE collection_id = p_collection_id
      AND game_date IS NOT NULL
  )
  SELECT c.* INTO v_player
  FROM cand c
  LEFT JOIN recent r ON true
  CROSS JOIN horizon h
  ORDER BY (CASE WHEN r.team_name IS NOT NULL
                  AND r.game_date >= h.max_gd - interval '18 months'
                  AND c.team = r.team_name
                 THEN 1 ELSE 0 END) DESC,
           c.team_edition_count DESC NULLS LAST,
           (c.is_active IS TRUE) DESC,
           (c.headshot_url IS NOT NULL) DESC,
           c.id
  LIMIT 1;

  IF v_player IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_collection_id = v_pinnacle_uuid AND EXISTS (
       SELECT 1 FROM pinnacle_catalog pc
       WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
     ) THEN
    -- 2026-09-26: the same render catalog get_player_editions lists, so the
    -- header counts the pins the grid shows. Minting dates stay from
    -- pinnacle_editions (the catalog carries none) and are NULL where it has none.
    SELECT
      COUNT(*),
      SUM(pc.total_minted) FILTER (WHERE pc.total_minted IS NOT NULL),
      SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
      SUM(COALESCE(pc.floor_ask, pc.fmv_usd)) FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM pinnacle_catalog pc
    WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))));
    -- 2026-09-27: dates only when EVERY row carries one. pinnacle_editions has a
    -- minting_date on 83 of 594 rows, so a MIN/MAX over the dated few published a
    -- span as fact (Mickey Mouse: "first minted" = "last minted" from 1 of 24
    -- rows, while his pins span 2023–2026). NULL hides the line.
    SELECT CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pe.minting_date) THEN MIN(pe.minting_date) END,
           CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pe.minting_date) THEN MAX(pe.minting_date) END
    INTO v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    WHERE pe.character_name = v_player.name;
  ELSIF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      CASE WHEN COUNT(*) = COUNT(pe.minting_date) THEN MIN(pe.minting_date) END,
      CASE WHEN COUNT(*) = COUNT(pe.minting_date) THEN MAX(pe.minting_date) END
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.character_name = v_player.name;
  ELSE
    SELECT
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      MIN(e.first_minted_at),
      MAX(e.first_minted_at)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR e.player_name = v_player.name);
  END IF;

  RETURN jsonb_build_object(
    'id',                v_player.id,
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'player_slug',       p_player_slug,
    'external_id',       v_player.external_id,
    'name',              v_player.name,
    'first_name',        v_player.first_name,
    'last_name',         v_player.last_name,
    'team',              v_player.team,
    'team_slug',         CASE WHEN v_player.team IS NULL THEN NULL
                              ELSE regexp_replace(lower(trim(v_player.team)), '[^a-z0-9]+', '-', 'g') END,
    'jersey_number',     v_player.jersey_number,
    'position',          v_player.position,
    'player_tier',       v_player.player_tier::text,
    'is_active',         v_player.is_active,
    'headshot_url',      v_player.headshot_url,
    'is_character',      p_collection_id = v_pinnacle_uuid,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;
