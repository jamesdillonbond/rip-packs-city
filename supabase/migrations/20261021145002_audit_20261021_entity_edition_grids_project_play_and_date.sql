-- audit_20261021_entity_edition_grids_project_play_and_date
--
-- 2026-10-21 (Cowork cloud, SEO pass, follow-on to 20261021142334). Edition
-- GRIDS (player / set / series / team / pack contents) still labelled distinct
-- editions identically: /nba-top-shot/player/kon-knueppel listed three tiles
-- reading "Signature Series · ULTIMATE · Series 2025-26 · FMV $9,000" — three
-- different plays (Assist Dec 31, Assist Feb 20, 3 Pointer Feb 27), the same
-- text on screen and as the internal link's anchor text. 20260925173217 added
-- subedition_name for parallels; the play and its date were never projected.
--
-- WHAT. Each editions branch projects e.play_category and e.game_date right
-- after e.subedition_name (the Pinnacle branches have no such columns and are
-- untouched). The three PINNED functions (get_player_editions,
-- get_series_editions, get_team_top_editions) are re-stated as LITERAL DDL =
-- the pin body (md5 matched against live prosrc immediately before writing)
-- plus those two lines per anchor; the two unpinned ones (get_set_editions,
-- get_pack_contents) take the same guarded splice 20260925173217 used, anchor
-- counts asserted. Headers / ACL unchanged (postgres, service_role).
--
-- anon-exec: unchanged (get_player_editions) — CREATE OR REPLACE of the same signature keeps its ACL; verified has_function_privilege('anon') = false.
-- anon-exec: unchanged (get_series_editions) — CREATE OR REPLACE of the same signature keeps its ACL; verified has_function_privilege('anon') = false.
-- anon-exec: unchanged (get_team_top_editions) — CREATE OR REPLACE of the same signature keeps its ACL; verified has_function_privilege('anon') = false.
-- anon-exec: unchanged (get_set_editions) — CREATE OR REPLACE of the same signature keeps its ACL; verified has_function_privilege('anon') = false.
-- anon-exec: unchanged (get_pack_contents) — CREATE OR REPLACE of the same signature keeps its ACL; verified has_function_privilege('anon') = false.
--
-- REVERT: re-apply each function's previous body (the pinned three from the
-- migrations their pins named before this one; the other two by removing the
-- two projected lines with the same splice) and re-point the three pins. The
-- tiles render no play line when the keys are absent.

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
        e.play_category,
        e.game_date,
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

CREATE OR REPLACE FUNCTION public.get_series_editions(p_collection_id uuid, p_series_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
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
  v_series        RECORD;
  v_pinnacle_year int;
  v_have_current  boolean;
  result          jsonb;
BEGIN
  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN '[]'::jsonb; END IF;

    -- 2026-09-26: the render catalog, keyed on its own series (season) — the
    -- old read was pinnacle_editions.series_year, set on only 87 rows, so a
    -- series page listed 11 editions for a year with 1,023 pins.
    WITH ed AS (
      SELECT
        pc.render_id                                        AS route_slug,
        btrim(pc.characters[1])                             AS player_name,
        btrim(pc.character_name)                            AS pin_name,
        regexp_replace(lower(btrim(pc.characters[1])), '[^a-z0-9]+', '-', 'g') AS player_slug,
        btrim(pc.character_name) || ' (' || pc.variant || ')' AS name,
        btrim(pc.set_name)                                  AS set_name,
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pc.variant                                          AS tier,
        public.series_display_label(p_collection_id, v_pinnacle_year) AS series_label,
        pc.total_minted                                     AS circulation_count,
        pc.thumbnail_url,
        pc.fmv_usd,
        pc.floor_ask                                        AS floor_usd,
        pc.fmv_confidence::text                             AS fmv_confidence,
        pc.fmv_usd                                          AS fmv_min,
        pc.fmv_usd                                          AS fmv_max,
        1                                                   AS render_count
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
      ORDER BY pc.fmv_usd DESC NULLS LAST, pc.render_id
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
    RETURN result;
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH pick AS (
      -- PHASE 1: ordering only, from the hourly rollup. No probes.
      SELECT e.id, e.first_minted_at, c.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
      ORDER BY c.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: live FMV + entity_rep_nft_id, over v_safe_limit rows only.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
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
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_category,
        e.game_date,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    -- No rollup for this collection. Original path: correct, and slow enough to
    -- notice, which is the point.
    WITH pick AS (
      SELECT e.id, e.first_minted_at, fmv.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
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
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_category,
        e.game_date,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_team_top_editions(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 200);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_team_variants text[];
  result          jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped, so "Star Wars™" and "Star Wars" are one franchise). The old read
    -- was pinnacle_editions — set-level keys naming ONE franchise and ONE
    -- character each — so Star Wars listed 129 of its 723 pins and ten
    -- franchises a character page links to had no page at all. A franchise no
    -- catalog pin carries falls through to that old read, unchanged.
    SELECT array_agg(DISTINCT f.name)
    INTO v_team_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NOT NULL THEN
      WITH ed AS (
        SELECT
          pc.render_id                                        AS route_slug,
          btrim(pc.characters[1])                             AS player_name,
          btrim(pc.character_name)                            AS pin_name,
          btrim(pc.character_name) || ' (' || pc.variant || ')' AS name,
          btrim(pc.set_name)                                  AS set_name,
          regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
          pc.variant                                          AS tier,
          99                                                  AS tier_rank,
          pc.series_name                                      AS series_label,
          CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_num,
          pc.total_minted                                     AS circulation_count,
          pc.thumbnail_url,
          v_team_variants[1]                                  AS team_name,
          pc.fmv_usd,
          pc.floor_ask                                        AS floor_usd,
          pc.fmv_confidence::text                             AS fmv_confidence,
          pc.fmv_computed_at,
          pc.fmv_usd                                          AS fmv_min,
          pc.fmv_usd                                          AS fmv_max,
          1                                                   AS render_count
        FROM pinnacle_catalog pc
        WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
        ORDER BY pc.fmv_usd DESC NULLS LAST, pc.render_id
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
      RETURN result;
    END IF;

    SELECT array_agg(DISTINCT franchise) INTO v_team_variants
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH ed AS (
      SELECT
        pe.id                                              AS route_slug,
        pe.character_name                                  AS player_name,
        pe.character_name || ' (' || pe.variant_type || ')' AS name,
        pe.set_name,
        regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pe.variant_type                                    AS tier,
        99                                                 AS tier_rank,
        pe.series_year::text                               AS series_label,
        pe.series_year                                     AS series_num,
        pe.mint_count                                      AS circulation_count,
        pe.thumbnail_url,
        pe.franchise                                       AS team_name,
        fmv.fmv_usd,
        fmv.floor_usd                                      AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at,
        fmv.fmv_min,
        fmv.fmv_max,
        fmv.render_count
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants)
        AND pe.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, pe.minting_date DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    SELECT array_agg(DISTINCT team_name) INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

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
        e.play_category,
        e.game_date,
        e.play_type,
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
        AND e.team_name = ANY(v_team_variants)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

-- The two unpinned grid RPCs: guarded splice on the live body.
DO $$
DECLARE r RECORD; v_src text; v_n int;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_arguments(p.oid) AS args,
           CASE p.proname WHEN 'get_pack_contents' THEN E'      e.subedition_name,\n' ELSE E'        e.subedition_name,\n' END AS anchor
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('get_set_editions','get_pack_contents')
     ORDER BY p.proname
  LOOP
    v_src := (SELECT prosrc FROM pg_proc WHERE oid = r.oid);
    IF position('e.play_category' IN v_src) > 0 THEN
      RAISE NOTICE '%: play_category already projected — no-op', r.proname;
      CONTINUE;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, r.anchor, ''))) / length(r.anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: expected the e.subedition_name anchor once, found %', r.proname, v_n;
    END IF;
    v_src := replace(v_src, r.anchor,
      r.anchor || replace(r.anchor, 'e.subedition_name,', 'e.play_category,') || replace(r.anchor, 'e.subedition_name,', 'e.game_date,'));
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' SET statement_timeout TO ''8s'' AS %L',
      r.proname, r.args, v_src);
  END LOOP;
END $$;

-- Post-conditions: all five project both keys; the Knueppel player grid carries
-- a play and a date on its editions.
DO $$
DECLARE v_missing text; v_rows jsonb; v_with int;
BEGIN
  SELECT string_agg(proname, ', ') INTO v_missing FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('get_player_editions','get_set_editions','get_series_editions','get_team_top_editions','get_pack_contents')
     AND (position('e.play_category' IN prosrc) = 0 OR position('e.game_date' IN prosrc) = 0);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'play/date not projected by: %', v_missing; END IF;
  v_rows := public.get_player_editions('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'kon-knueppel', 100, 0);
  SELECT count(*) FILTER (WHERE x->>'play_category' IS NOT NULL AND x->>'game_date' IS NOT NULL) INTO v_with
    FROM jsonb_array_elements(v_rows) x;
  IF v_with = 0 THEN RAISE EXCEPTION 'kon-knueppel: no edition carries play_category + game_date'; END IF;
END $$;
