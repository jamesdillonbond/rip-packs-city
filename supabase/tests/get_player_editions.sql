-- DB invariant: public.get_player_editions — the Pinnacle branch. Added
-- 2026-09-26: the branch read pinnacle_editions filtered to rows WITH a
-- thumbnail, so 36 of 248 character pages rendered no editions at all. Claims:
--
--   1. A character the catalog names lists ITS PINS from pinnacle_catalog —
--      render_id route, own art, own FMV, highest FMV first.
--   2. A two-character pin lists under BOTH characters.
--   3. Another character's pins never appear (the match is on the Characters
--      trait, case/space-insensitive — not a substring of the render name).
--   4. A character the catalog does not name falls back to pinnacle_editions.
--   5. An unknown slug is [] (never another subject's rows).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926191644_audit_20260926_pinnacle_duo_character_pages_find_their_pins.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, name text NOT NULL);
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, character_name text, characters text[], set_name text, variant text,
  series_name text, total_minted int, thumbnail_url text, fmv_usd numeric, floor_ask numeric,
  fmv_confidence text, fmv_computed_at timestamptz
);
CREATE TABLE public.pinnacle_editions (
  id text PRIMARY KEY, character_name text, variant_type text, set_name text, series_year int,
  mint_count int, thumbnail_url text, minting_date timestamptz
);
-- The fallback's FMV helper, stubbed: this test pins which ROWS list, not FMV.
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id text)
RETURNS TABLE (fmv_usd numeric, floor_usd numeric, confidence text, computed_at timestamptz, fmv_min numeric, fmv_max numeric, render_count int)
LANGUAGE sql AS $$ SELECT 5::numeric, 4::numeric, 'LOW'::text, now(), 5::numeric, 5::numeric, 1 $$;
-- Only reached by the non-Pinnacle branch; defined so the function body resolves.
CREATE TABLE public.editions (id uuid, collection_id uuid, external_id text, player_id uuid, player_name text, name text, set_name text,
  tier text, series int, circulation_count int, thumbnail_url text, video_url text, team_name text, subedition_name text, first_minted_at timestamptz);
CREATE TABLE public.fmv_snapshots (edition_id uuid, fmv_usd numeric, floor_price_usd numeric, confidence text, computed_at timestamptz);
CREATE FUNCTION public.entity_rep_nft_id(uuid, text, uuid) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;

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
        AND (e.player_id = v_player.id OR e.player_name = v_player.name)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

INSERT INTO public.players (collection_id, name) VALUES
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Aurora'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Maleficent'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Maurice & Cogsworth');
INSERT INTO public.pinnacle_catalog VALUES
  ('LEV1-SLBT-FORE-S6', 'Forest Song',  ARRAY['Aurora'], ' Sleeping Beauty Vol.1 ', 'Standard', '2025', 500, '/api/public/pinnacle-image/LEV1-SLBT-FORE-S6', 12, 10, 'HIGH', now()),
  ('LEV1-SLBT-SPIN-S6', 'Spinning Wheel', ARRAY['aurora '], 'Sleeping Beauty Vol.1', 'Standard', '2025', 500, '/api/public/pinnacle-image/LEV1-SLBT-SPIN-S6', 30, 25, 'MEDIUM', now()),
  ('LEV1-SLBT-DUEL-S6', 'The Duel', ARRAY['Maleficent', 'Aurora'], 'Sleeping Beauty Vol.1', 'Golden', '2025', 50, '/api/public/pinnacle-image/LEV1-SLBT-DUEL-S6', NULL, NULL, NULL, NULL),
  ('LEV1-SLBT-DARK-S6', 'Dark Fairy', ARRAY['Maleficent'], 'Sleeping Beauty Vol.1', 'Standard', '2025', 500, '/api/public/pinnacle-image/LEV1-SLBT-DARK-S6', 8, 7, 'LOW', now()),
  ('X-AURORAISH-S1', 'Aurora Borealis', ARRAY['Aurora Borealis'], 'Sky Vol.1', 'Standard', '2025', 500, '/api/public/pinnacle-image/X-AURORAISH-S1', 99, 90, 'HIGH', now());
INSERT INTO public.pinnacle_editions VALUES
  ('WDAS-LEV2-BATB:Standard:1', 'Maurice & Cogsworth', 'Standard', 'Beauty and the Beast Vol.2', 2025, 300, '/api/public/pinnacle-image/LEV2-BATB-MACO-S2', now()),
  ('WDAS-LEV2-BATB:Golden:1', 'Maurice & Cogsworth', 'Golden', 'Beauty and the Beast Vol.2', 2025, 30, NULL, now());

-- 1 + 3: Aurora's pins, highest FMV first, NOT the "Aurora Borealis" pin.
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',' ORDER BY ord) FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'aurora')) WITH ORDINALITY t(e, ord)),
  'LEV1-SLBT-SPIN-S6,LEV1-SLBT-FORE-S6,LEV1-SLBT-DUEL-S6', 'a character lists its own pins, highest FMV first, unpriced last');
SELECT _assert_eq(
  (SELECT e->>'thumbnail_url' || '|' || (e->>'fmv_usd') || '|' || (e->>'set_name') || '|' || (e->>'name') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'aurora')) e WHERE e->>'route_slug' = 'LEV1-SLBT-FORE-S6'),
  '/api/public/pinnacle-image/LEV1-SLBT-FORE-S6|12|Sleeping Beauty Vol.1|Forest Song (Standard)', 'each pin carries its own art, FMV and trimmed set');

-- 2
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',' ORDER BY e->>'route_slug') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'maleficent')) e),
  'LEV1-SLBT-DARK-S6,LEV1-SLBT-DUEL-S6', 'a two-character pin lists under both characters');

-- 4: the fallback is the previous read, unchanged (thumbnail filter included).
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'maurice-cogsworth')) e),
  'WDAS-LEV2-BATB:Standard:1', 'a character the catalog does not name falls back to pinnacle_editions');

-- 5
SELECT _assert_eq(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'nobody')::text, '[]', 'unknown slug is empty');

-- 6: a DUO character (combined name) finds the pins that list BOTH characters,
-- and a single character never picks up a pin by the joined-name rule.
INSERT INTO public.players (collection_id, name) VALUES
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Monterey Jack & Zipper'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Merida Angus'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Zipper');
INSERT INTO public.pinnacle_catalog VALUES
  ('OEV1-CDRR-MOJA-S2', 'Cheese!', ARRAY['Monterey Jack', 'Zipper'], 'Rescue Rangers Vol.1', 'Standard', '2025', 500, '/api/public/pinnacle-image/OEV1-CDRR-MOJA-S2', 3, 2, 'LOW', now()),
  ('OEV1-BRAV-MEAN-S2', 'Horseback', ARRAY['Merida', 'Angus'], 'Brave Vol.1', 'Standard', '2025', 500, '/api/public/pinnacle-image/OEV1-BRAV-MEAN-S2', 4, 3, 'LOW', now());
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'monterey-jack-zipper')) e),
  'OEV1-CDRR-MOJA-S2', 'a duo joined with " & " finds its pin');
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'merida-angus')) e),
  'OEV1-BRAV-MEAN-S2', 'a duo joined with a space finds its pin');
SELECT _assert_eq(
  (SELECT string_agg(e->>'route_slug', ',') FROM jsonb_array_elements(public.get_player_editions('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'zipper')) e),
  'OEV1-CDRR-MOJA-S2', 'a single character still lists a pin it is IN (element match), no more');

ROLLBACK;
