-- DB invariant: public.get_team_top_editions + public.get_team_players — the
-- Pinnacle branch (the grid and roster of /disney-pinnacle/team/<slug>). Added
-- 2026-09-26: both read pinnacle_editions (set-level keys, one franchise and one
-- character each) and the grid dropped keys with no thumbnail, so Star Wars
-- listed 98 of its 723 pins and 10 franchises had no page. Claims:
--
--   1. The grid lists every catalog pin whose Franchises trait names the
--      franchise, ™/®/© stripped (so "Star Wars™" pins list under star-wars),
--      a multi-franchise pin under each; highest FMV first; route = render_id.
--   2. The roster has one row per character page over EVERY name on a pin (a
--      duo pin counts for both), 'Unknown' excluded; FMV-ordered.
--   3. A catalog-only franchise lists its pins.
--   4. A franchise no catalog pin names falls through to the legacy
--      pinnacle_editions read; an unknown slug is [].
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926195205_audit_20260926_pinnacle_franchise_pages_list_every_pin.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, franchises text[], characters text[], character_name text,
  set_name text, variant text, series_name text, total_minted int, thumbnail_url text,
  fmv_usd numeric, floor_ask numeric, fmv_confidence text, fmv_computed_at timestamptz);
CREATE TABLE public.pinnacle_editions (
  id text PRIMARY KEY, franchise text, character_name text, variant_type text, set_name text,
  series_year int, mint_count int, thumbnail_url text, minting_date timestamptz);
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id text)
 RETURNS TABLE(fmv_usd numeric, floor_usd numeric, confidence text, computed_at timestamptz,
               fmv_min numeric, fmv_max numeric, render_count int)
 LANGUAGE sql STABLE AS $$ SELECT 3::numeric, 2::numeric, 'LOW', now(), 3::numeric, 3::numeric, 1 WHERE p_id IS NOT NULL $$;

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

CREATE OR REPLACE FUNCTION public.get_team_players(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
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
      -- One row per character page (slug), over every name on a pin.
      WITH ch AS (
        SELECT btrim(u.ch) AS name, pc.render_id, pc.total_minted, pc.fmv_usd, pc.thumbnail_url
        FROM pinnacle_catalog pc
        CROSS JOIN LATERAL unnest(pc.characters) AS u(ch)
        WHERE btrim(u.ch) NOT IN ('', 'Unknown')
          AND EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
      ),
      chars AS (
        SELECT
          (array_agg(ch.render_id ORDER BY ch.fmv_usd DESC NULLS LAST, ch.render_id))[1] AS id,
          MIN(ch.name) AS name,
          regexp_replace(lower(ch.name), '[^a-z0-9]+', '-', 'g') AS player_slug,
          NULL::text AS headshot_url,
          NULL::int  AS jersey_number,
          NULL::text AS position,
          NULL::boolean AS is_active,
          false AS is_rookie,
          COUNT(DISTINCT ch.render_id) AS edition_count,
          SUM(ch.total_minted) FILTER (WHERE ch.total_minted IS NOT NULL) AS total_circulation,
          SUM(ch.fmv_usd)      FILTER (WHERE ch.fmv_usd > 0) AS fmv_total_usd,
          (array_agg(ch.thumbnail_url ORDER BY ch.fmv_usd DESC NULLS LAST, ch.render_id) FILTER (WHERE ch.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
        FROM ch
        GROUP BY regexp_replace(lower(ch.name), '[^a-z0-9]+', '-', 'g')
        ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
        LIMIT v_safe_limit OFFSET v_safe_offset
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(chars.*)), '[]'::jsonb) INTO result FROM chars;
      RETURN result;
    END IF;

    SELECT array_agg(DISTINCT franchise) INTO v_team_variants
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH chars AS (
      SELECT
        (array_agg(pe.id ORDER BY pe.minting_date DESC NULLS LAST))[1] AS id,
        pe.character_name AS name,
        regexp_replace(lower(trim(pe.character_name)), '[^a-z0-9]+', '-', 'g') AS player_slug,
        NULL::text AS headshot_url,
        NULL::int  AS jersey_number,
        NULL::text AS position,
        NULL::boolean AS is_active,
        false AS is_rookie,
        COUNT(*) AS edition_count,
        SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL) AS total_circulation,
        SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total_usd,
        (array_agg(pe.thumbnail_url ORDER BY pe.minting_date DESC NULLS LAST) FILTER (WHERE pe.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
      FROM pinnacle_editions pe
      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants)
      GROUP BY pe.character_name
      ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(chars.*)), '[]'::jsonb) INTO result FROM chars;
  ELSE
    SELECT array_agg(DISTINCT team_name) INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)

    IF v_team_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH team_eds AS (
      SELECT
        e.id,
        e.player_name,
        regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') AS player_slug,
        e.circulation_count,
        e.thumbnail_url,
        e.first_minted_at
      FROM editions e
      WHERE e.collection_id = p_collection_id
        AND e.team_name = ANY(v_team_variants)
        AND e.player_name IS NOT NULL
        AND e.player_name <> ''
    ),
    agg AS (
      SELECT
        te.player_slug,
        MIN(te.player_name) AS name,
        COUNT(DISTINCT te.id) AS edition_count,
        SUM(te.circulation_count) FILTER (WHERE te.circulation_count IS NOT NULL) AS total_circulation,
        SUM(fmv.fmv_usd) FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total_usd,
        (array_agg(te.thumbnail_url ORDER BY te.first_minted_at DESC NULLS LAST) FILTER (WHERE te.thumbnail_url IS NOT NULL))[1] AS portrait_thumbnail
      FROM team_eds te
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = te.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      GROUP BY te.player_slug
    ),
    with_meta AS (
      SELECT
        pm.id AS id,
        a.name,
        a.player_slug,
        pm.headshot_url,
        pm.jersey_number,
        pm.position,
        pm.is_active,
        EXISTS (
          SELECT 1 FROM topshot_2025_rookie_players r
          WHERE regexp_replace(lower(trim(r.player_name)), '[^a-z0-9]+', '-', 'g') = a.player_slug
        ) AS is_rookie,
        a.edition_count,
        a.total_circulation,
        a.fmv_total_usd,
        a.portrait_thumbnail
      FROM agg a
      LEFT JOIN LATERAL (
        SELECT p.id, p.headshot_url, p.jersey_number, p.position, p.is_active
        FROM players p
        WHERE p.collection_id = p_collection_id
          AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = a.player_slug
        ORDER BY (p.headshot_url IS NOT NULL) DESC, p.id
        LIMIT 1
      ) pm ON true
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result
    FROM (
      SELECT * FROM with_meta
      ORDER BY fmv_total_usd DESC NULLS LAST, edition_count DESC, name
      LIMIT v_safe_limit OFFSET v_safe_offset
    ) t;
  END IF;

  RETURN result;
END;
$function$;

\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

INSERT INTO public.pinnacle_catalog (render_id, franchises, characters, character_name, set_name, variant, series_name, total_minted, thumbnail_url, fmv_usd, floor_ask, fmv_confidence) VALUES
  ('r1', ARRAY['Star Wars™'],             ARRAY['Luke Skywalker'],        'Luke Skywalker',        ' Set A ', 'Standard', '2024', 100, '/img/r1', 10,   8,    'HIGH'),
  ('r2', ARRAY['Star Wars'],              ARRAY['Luke Skywalker','Leia'], 'Luke Skywalker & Leia', 'Set A',   'Brushed',  '2025',  50, NULL,       5,    NULL, 'LOW'),
  ('r3', ARRAY['Moana'],                  ARRAY['Moana'],                 'Moana',                 'Set B',   'Standard', '2025',  25, '/img/r3', 7,    6,    'MEDIUM'),
  ('r4', ARRAY['Star Wars','Lucasfilm'],  ARRAY['Unknown'],               'Unknown',               'Set C',   'Standard', '2025', NULL, '/img/r4', NULL, NULL, NULL),
  ('r5', ARRAY['Star Wars'],              ARRAY['Leia'],                  'Leia',                  'Set C',   'Standard', '2025',  10, '/img/r5', 20,   NULL, 'HIGH');
-- Marvel exists ONLY in pinnacle_editions (the legacy fallback).
INSERT INTO public.pinnacle_editions (id, franchise, character_name, variant_type, set_name, series_year, mint_count, thumbnail_url) VALUES
  ('MRV:Standard:1', 'Marvel', 'Iron Man', 'Standard', 'Marvel Set', 2024, 500, '/img/m1');

-- ── 1. grid: every Star Wars pin, ™ or not, FMV-first, render routes ─────────
SELECT _assert_eq(jsonb_array_length(public.get_team_top_editions(:pin::uuid, 'star-wars', 50, 0))::text, '4',
  'grid lists every pin naming Star Wars (™ stripped, multi-franchise included, no-art pin kept)');
SELECT _assert_eq((SELECT string_agg(x->>'route_slug', ',') FROM jsonb_array_elements(public.get_team_top_editions(:pin::uuid, 'star-wars', 50, 0)) x),
  'r5,r1,r2,r4', 'grid is FMV-ordered, unpriced last, routes by render_id');
SELECT _assert_eq((public.get_team_top_editions(:pin::uuid, 'star-wars', 50, 0) -> 1 ->> 'set_slug'), 'set-a', 'set slug from the trimmed set name');
SELECT _assert_eq((public.get_team_top_editions(:pin::uuid, 'star-wars', 50, 0) -> 1 ->> 'team_name'), 'Star Wars', 'team_name carries no ™');
SELECT _assert_eq(jsonb_array_length(public.get_team_top_editions(:pin::uuid, 'star-wars', 2, 0))::text, '2', 'limit applies');
SELECT _assert_eq(jsonb_array_length(public.get_team_top_editions(:pin::uuid, 'lucasfilm', 50, 0))::text, '1', 'a pin lists under every franchise it names');
SELECT _assert_eq((public.get_team_top_editions(:pin::uuid, 'moana', 50, 0) -> 0 ->> 'route_slug'), 'r3', 'a catalog-only franchise lists its pins');

-- ── 2. roster: one row per character page, every name on a pin ──────────────
SELECT _assert_eq((SELECT string_agg(x->>'player_slug', ',') FROM jsonb_array_elements(public.get_team_players(:pin::uuid, 'star-wars', 50, 0)) x),
  'leia,luke-skywalker', 'roster: Leia (20+5) before Luke (10+5); the duo pin counts for both; Unknown excluded');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'star-wars', 50, 0) -> 1 ->> 'edition_count'), '2', 'Luke: his solo pin + the duo pin');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'star-wars', 50, 0) -> 0 ->> 'edition_count'), '2', 'Leia: her solo pin + the duo pin, where she is the SECOND name');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'star-wars', 50, 0) -> 0 ->> 'fmv_total_usd'), '25', 'Leia: 20 + the duo pin 5');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'star-wars', 50, 0) -> 0 ->> 'portrait_thumbnail'), '/img/r5', 'portrait = the highest-FMV pin with art');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'lucasfilm', 50, 0))::text, '[]', 'a franchise whose only pin names Unknown lists no roster row');

-- ── 3. legacy fallback + unknown ────────────────────────────────────────────
SELECT _assert_eq((public.get_team_top_editions(:pin::uuid, 'marvel', 50, 0) -> 0 ->> 'route_slug'), 'MRV:Standard:1', 'a franchise no catalog pin names falls through to pinnacle_editions');
SELECT _assert_eq((public.get_team_players(:pin::uuid, 'marvel', 50, 0) -> 0 ->> 'name'), 'Iron Man', 'roster falls through too');
SELECT _assert_eq(public.get_team_top_editions(:pin::uuid, 'no-such-franchise', 50, 0)::text, '[]', 'unknown slug -> [] (grid)');
SELECT _assert_eq(public.get_team_players(:pin::uuid, 'no-such-franchise', 50, 0)::text, '[]', 'unknown slug -> [] (roster)');

SELECT '✓ get_team_top_editions + get_team_players: all assertions passed' AS result;

ROLLBACK;
