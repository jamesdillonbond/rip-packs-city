-- audit_20261020_player_pages_never_borrow_another_persons_editions
--
-- 2026-10-20 ~8:50 PM PT (Claude Code cloud; Trevor: "work on roadmap items and
-- known issues"). CLAUDE.md concierge rule 2: a NAME is not a PERSON. Found by a
-- read-only sweep of live player pages.
--
-- WHAT WAS WRONG. get_player_detail and get_player_editions match an edition to a
-- player page by `e.player_id = v.id OR e.player_name = v.name`. The name arm is
-- the fallback for editions not yet linked to a player row, but it also fires for
-- editions LINKED to somebody else who happens to carry (or once carried) the
-- name. Measured live 10-20 ~8:50 PM PT: exactly 17 editions, all on All Day:
--   /nfl-all-day/player/josh-allen       8 editions of Josh Hines-Allen (the Jaguars
--                                         edge rusher; played as "Josh Allen" to 2023)
--   /nfl-all-day/player/marvin-harrison  8 editions of Marvin Harrison Jr.
--   /nfl-all-day/player/joey-porter      1 edition of Joey Porter Jr. (2024 Stadium, 3591)
-- Each pair is already curated in player_relations (parent_of / name_change).
--
-- WHAT CHANGES. The name arm now also requires NOT
-- edition_player_is_other_person(e.player_id, v.id): TRUE only when the edition is
-- linked to a DIFFERENT player row that player_relations records as another person
-- (parent_of / namesake, either direction) or as having changed names (name_change:
-- the edition is that person's, under their old name). Unlinked editions
-- (player_id NULL) and same-person twin rows (the D26 merge class, e.g. Top Shot
-- Abdul-Rauf / Abul-Rauf) keep matching by name exactly as before; so do the Panini
-- country cards. The bodies are the pinned migrations' DDL verbatim except for the
-- three replaced predicates (20260929063531 for get_player_detail, 20260926191644
-- for get_player_editions; both md5-matched against live prosrc before writing).
-- Not changed: rpc_search_catalog's per-player result COUNT uses the same OR
-- (a count shown in search, not a list); recorded for a follow-up.
--
-- anon-exec: revoked (edition_player_is_other_person) — new helper; called only from SECURITY DEFINER functions owned by postgres; GRANT postgres, service_role.
-- anon-exec: unchanged (get_player_detail) — CREATE OR REPLACE of the same signature keeps its ACL.
-- anon-exec: unchanged (get_player_editions) — CREATE OR REPLACE of the same signature keeps its ACL.
--
-- REVERT: re-apply the two pinned bodies (20260929063531 / 20260926191644), then
--   DROP FUNCTION public.edition_player_is_other_person(uuid, uuid);

CREATE OR REPLACE FUNCTION public.edition_player_is_other_person(p_edition_player_id uuid, p_page_player_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_edition_player_id IS NOT NULL
     AND p_edition_player_id IS DISTINCT FROM p_page_player_id
     AND EXISTS (
       SELECT 1 FROM player_relations r
        WHERE (r.relation IN ('parent_of', 'namesake')
               AND ((r.player_id = p_page_player_id AND r.related_player_id = p_edition_player_id)
                 OR (r.player_id = p_edition_player_id AND r.related_player_id = p_page_player_id)))
           OR (r.relation = 'name_change' AND r.player_id = p_edition_player_id)
     )
$function$;

REVOKE EXECUTE ON FUNCTION public.edition_player_is_other_person(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edition_player_is_other_person(uuid, uuid) TO postgres, service_role;

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
  v_fmv_ask_derived  numeric;
  v_listed_count     int;
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR (e.player_name = p.name AND NOT public.edition_player_is_other_person(e.player_id, p.id)))
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
      SUM(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
      SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
      COUNT(*)             FILTER (WHERE pc.floor_ask > 0)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_fmv_ask_derived, v_listed_count
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
      AND (e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT public.edition_player_is_other_person(e.player_id, v_player.id)));
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
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',      v_listed_count,
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_player_editions(p_collection_id uuid, p_player_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_player        RECORD;
  result          jsonb;
BEGIN
  SELECT p.* INTO v_player
  FROM players p
  WHERE p.collection_id = p_collection_id
    AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  LIMIT 1;

  IF v_player IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: Pinnacle character pages read the RENDER catalog (one row per
    -- pin, each with its own art and its own FMV), matched on the Characters
    -- trait. The old read was pinnacle_editions (set-level legacy keys) filtered
    -- to rows WITH a thumbnail, so 36 character pages rendered NO editions
    -- (Aurora: both rows unthumbnailed) and the rest showed one card per
    -- set-level key. The old read stays as the fallback for a character the
    -- catalog does not name (combined names such as "Maurice & Cogsworth").
    IF EXISTS (
      SELECT 1 FROM pinnacle_catalog pc
      WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
    ) THEN
      WITH ed AS (
        SELECT
          pc.render_id                                       AS route_slug,
          btrim(pc.character_name)                           AS player_name,
          btrim(pc.character_name) || ' (' || pc.variant || ')' AS name,
          btrim(pc.set_name)                                 AS set_name,
          regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
          pc.variant                                         AS tier,
          pc.series_name                                     AS series_label,
          CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_num,
          pc.total_minted                                    AS circulation_count,
          pc.thumbnail_url,
          pc.fmv_usd,
          pc.floor_ask                                       AS floor_usd,
          pc.fmv_confidence::text                            AS fmv_confidence,
          pc.fmv_computed_at                                 AS fmv_computed_at,
          pc.fmv_usd                                         AS fmv_min,
          pc.fmv_usd                                         AS fmv_max,
          1                                                  AS render_count
        FROM pinnacle_catalog pc
        WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
        ORDER BY pc.fmv_usd DESC NULLS LAST, pc.render_id
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
    ELSE
      WITH ed AS (
        SELECT
          pe.id                                              AS route_slug,
          pe.character_name                                  AS player_name,
          pe.character_name || ' (' || pe.variant_type || ')' AS name,
          pe.set_name,
          regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
          pe.variant_type                                    AS tier,
          pe.series_year::text                               AS series_label,
          pe.series_year                                     AS series_num,
          pe.mint_count                                      AS circulation_count,
          pe.thumbnail_url,
          fmv.fmv_usd,
          fmv.floor_usd                                      AS floor_usd,
          fmv.confidence::text                               AS fmv_confidence,
          fmv.computed_at                                    AS fmv_computed_at,
          fmv.fmv_min,
          fmv.fmv_max,
          fmv.render_count
        FROM pinnacle_editions pe
        LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
        WHERE pe.character_name = v_player.name
          AND pe.thumbnail_url IS NOT NULL
        ORDER BY fmv.fmv_usd DESC NULLS LAST, pe.minting_date DESC NULLS LAST
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
    END IF;
  ELSE
    WITH ed AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.series::text                                     AS series_label,
        e.series                                           AS series_num,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND (e.player_id = v_player.id OR (e.player_name = v_player.name AND NOT public.edition_player_is_other_person(e.player_id, v_player.id)))
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;
