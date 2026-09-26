-- DB invariant: public.get_series_editions + public.get_series_rollups — the
-- Pinnacle branch. Added 2026-09-26: both read pinnacle_editions by
-- series_year (set on 87 rows), so a series page described 11 editions for a
-- year with 1,023 pins. Claims:
--
--   1. The grid lists the year's catalog pins (render_id route, own art + FMV),
--      highest FMV first — pins of other years never appear.
--   2. A pin with no art still lists (the old read dropped it).
--   3. Rollups: sets by trimmed name, top characters by the Characters trait
--      (whose pages exist), FMV-ordered.
--   4. An unknown series is [] / empty lists.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926193906_audit_20260926_pinnacle_series_pages_count_every_pin.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collection_series (collection_id uuid, series_number int, display_label text, season text);
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, character_name text, characters text[], set_name text, variant text,
  series_name text, total_minted int, thumbnail_url text, fmv_usd numeric, floor_ask numeric, fmv_confidence text
);
CREATE FUNCTION public.series_display_label(p_collection_id uuid, p_series int) RETURNS text
LANGUAGE sql AS $$ SELECT p_series::text $$;

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

CREATE OR REPLACE FUNCTION public.get_series_rollups(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_empty         CONSTANT jsonb := jsonb_build_object('sets', '[]'::jsonb, 'players', '[]'::jsonb);
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

  IF v_series IS NULL THEN RETURN v_empty; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN v_empty; END IF;

    -- 2026-09-26: from the render catalog (see get_series_editions).
    WITH ed AS (
      SELECT
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        btrim(pc.set_name) AS set_name,
        regexp_replace(lower(btrim(pc.characters[1])), '[^a-z0-9]+', '-', 'g') AS player_slug,
        btrim(pc.characters[1]) AS player_name,
        pc.fmv_usd
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;

    RETURN COALESCE(result, v_empty);
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        c.fmv_usd
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  ELSE
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        fmv.fmv_usd
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  END IF;

  RETURN COALESCE(result, v_empty);
END;
$function$;

INSERT INTO public.collection_series VALUES
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 3, '2026', '2026'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 2, '2025', '2025');
INSERT INTO public.pinnacle_catalog VALUES
  ('A-2026-1', 'Forest Song', ARRAY['Aurora'], ' Sleeping Beauty Vol.1 ', 'Standard', '2026', 500, '/api/public/pinnacle-image/A-2026-1', 12, 10, 'HIGH'),
  ('A-2026-2', 'The Duel', ARRAY['Maleficent', 'Aurora'], 'Sleeping Beauty Vol.1', 'Golden', '2026', 50, NULL, 40, NULL, 'LOW'),
  ('A-2026-3', 'Hero', ARRAY['Hercules'], 'Hercules Vol.1', 'Standard', '2026', 900, '/api/public/pinnacle-image/A-2026-3', NULL, NULL, NULL),
  ('A-2025-1', 'Old', ARRAY['Aurora'], 'Classics Vol.1', 'Standard', '2025', 900, '/api/public/pinnacle-image/A-2025-1', 99, 90, 'HIGH');

-- 1 + 2
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',' ORDER BY ord) FROM jsonb_array_elements(public.get_series_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', '2026')) WITH ORDINALITY t(e, ord)),
  'A-2026-2,A-2026-1,A-2026-3', 'the year''s pins, FMV first, art-less pin included, other years excluded');
SELECT _assert_eq(
  (SELECT (e->>'player_slug') || '|' || (e->>'set_name') || '|' || (e->>'fmv_usd') FROM jsonb_array_elements(public.get_series_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', '2026')) e WHERE e->>'route_slug' = 'A-2026-1'),
  'aurora|Sleeping Beauty Vol.1|12', 'character slug from the trait; trimmed set; own FMV');

-- 3
SELECT _assert_eq(
  (SELECT string_agg((s->>'set_name') || ':' || (s->>'edition_count'), ',' ORDER BY ord) FROM jsonb_array_elements(public.get_series_rollups('7dd9dd11-e8b6-45c4-ac99-71331f959714', '2026')->'sets') WITH ORDINALITY t(s, ord)),
  'Sleeping Beauty Vol.1:2,Hercules Vol.1:1', 'sets by trimmed name, FMV-ordered');
SELECT _assert_eq(
  (SELECT string_agg(p->>'player_slug', ',' ORDER BY ord) FROM jsonb_array_elements(public.get_series_rollups('7dd9dd11-e8b6-45c4-ac99-71331f959714', '2026')->'players') WITH ORDINALITY t(p, ord)),
  'maleficent,aurora,hercules', 'top characters by trait, FMV-ordered');

-- 4
SELECT _assert_eq(public.get_series_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', '1999')::text, '[]', 'unknown series: empty grid');
SELECT _assert_eq(public.get_series_rollups('7dd9dd11-e8b6-45c4-ac99-71331f959714', '1999')::text, '{"sets": [], "players": []}', 'unknown series: empty lists');

ROLLBACK;
