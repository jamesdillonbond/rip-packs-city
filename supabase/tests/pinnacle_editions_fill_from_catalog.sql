-- DB invariant: public.pinnacle_editions_fill_from_catalog — writes
-- pinnacle_editions rows for catalog legacy keys no wallet-walking lane reached,
-- and fills 'Unknown' stub fields from the catalog. Added 2026-09-26 (Disney
-- Genesis had no row; Finding Nemo Vol.2 was an Unknown stub). Claims:
--
--   1. A catalog-only key gets a row from the catalog's fields; the character is
--      the key's LOWEST render_id (stable), not whichever row a scan meets first.
--   2. mint_count only when every render under the key agrees, else NULL.
--   3. A stub's 'Unknown' fields are filled; a REAL value is never overwritten.
--   4. A render with no character or no set name writes nothing.
--   5. Idempotent: a second run reports inserted 0, repaired 0.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926171433_audit_20260926_pinnacle_catalog_only_sets_and_editions_reach_the_set_pages.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, legacy_edition_key text, characters text[], franchises text[],
  set_name text, royalty_code text, variant text, edition_type text, printing int,
  limited_edition boolean, is_chaser boolean, series_name text, total_minted int
);
CREATE TABLE public.pinnacle_editions (
  id text PRIMARY KEY, edition_key text, character_name text NOT NULL, franchise text NOT NULL DEFAULT 'Unknown',
  set_name text NOT NULL, royalty_code text, series_year int, variant_type text NOT NULL DEFAULT 'Standard',
  edition_type text NOT NULL DEFAULT 'Open Edition', printing int NOT NULL DEFAULT 1, mint_count int,
  is_serialized boolean NOT NULL DEFAULT false, is_chaser boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.pinnacle_editions_fill_from_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_repaired integer;
BEGIN
  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key                      AS k,
      NULLIF(btrim(pc.characters[1]), '')        AS character_name,
      NULLIF(btrim(pc.franchises[1]), '')        AS franchise,
      NULLIF(btrim(pc.set_name), '')             AS set_name,
      pc.royalty_code,
      pc.variant,
      pc.edition_type,
      pc.printing,
      pc.limited_edition,
      pc.is_chaser,
      CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_year
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  ),
  minted AS (
    SELECT pc.legacy_edition_key AS k,
           CASE WHEN count(DISTINCT pc.total_minted) = 1 AND count(pc.total_minted) = count(*)
                THEN min(pc.total_minted) END AS mint_count
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    GROUP BY pc.legacy_edition_key
  )
  INSERT INTO public.pinnacle_editions (
    id, edition_key, character_name, franchise, set_name, royalty_code,
    series_year, variant_type, edition_type, printing, mint_count,
    is_serialized, is_chaser
  )
  SELECT r.k, r.k, r.character_name, COALESCE(r.franchise, 'Unknown'), r.set_name,
         r.royalty_code, r.series_year, COALESCE(r.variant, 'Standard'),
         COALESCE(r.edition_type, 'Open Edition'), COALESCE(r.printing, 1),
         m.mint_count, COALESCE(r.limited_edition, false), COALESCE(r.is_chaser, false)
  FROM rep r
  JOIN minted m ON m.k = r.k
  WHERE r.character_name IS NOT NULL
    AND r.set_name IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.pinnacle_editions pe WHERE pe.id = r.k)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key               AS k,
      NULLIF(btrim(pc.characters[1]), '') AS character_name,
      NULLIF(btrim(pc.franchises[1]), '') AS franchise,
      NULLIF(btrim(pc.set_name), '')      AS set_name
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  )
  UPDATE public.pinnacle_editions pe
     SET character_name = CASE WHEN pe.character_name = 'Unknown' AND r.character_name IS NOT NULL THEN r.character_name ELSE pe.character_name END,
         franchise      = CASE WHEN pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL THEN r.franchise      ELSE pe.franchise      END,
         set_name       = CASE WHEN pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL THEN r.set_name       ELSE pe.set_name       END,
         updated_at     = now()
    FROM rep r
   WHERE r.k = pe.id
     AND (   (pe.character_name = 'Unknown' AND r.character_name IS NOT NULL)
          OR (pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL)
          OR (pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL));
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'repaired', v_repaired);
END;
$function$;

INSERT INTO public.pinnacle_catalog VALUES
  -- catalog-only key, two characters, agreeing mint 1: row names the LOWER render_id.
  ('R-B', 'LGEV4-TOYS:Apex:1', ARRAY['Woody'], ARRAY['Toy Story'], ' Toy Story Vol.4 ', 'LGEV4-TOYS', 'Apex', 'Legendary Edition', 1, true, false, '2026', 1),
  ('R-A', 'LGEV4-TOYS:Apex:1', ARRAY['Bo Peep'], ARRAY['Toy Story'], ' Toy Story Vol.4 ', 'LGEV4-TOYS', 'Apex', 'Legendary Edition', 1, true, false, '2026', 1),
  -- catalog-only key whose renders DISAGREE on mint count.
  ('R-C', 'OEV1-X:Standard:1', ARRAY['Yoda'], ARRAY['Star Wars'], 'Trivia Vol.1', 'OEV1-X', 'Standard', 'Starter Edition', 1, false, false, '2026', 1500),
  ('R-D', 'OEV1-X:Standard:1', ARRAY['Vader'], ARRAY['Star Wars'], 'Trivia Vol.1', 'OEV1-X', 'Standard', 'Starter Edition', 1, false, false, '2026', 900),
  -- the stub's key.
  ('R-E', 'LEEV2-FIND:Radiant Chrome:1', ARRAY['Dory'], ARRAY['Finding Nemo'], 'Finding Nemo Vol.2', 'LEEV2-FIND', 'Radiant Chrome', 'Limited Edition', 1, true, false, '2025', 50),
  -- a key with a REAL row whose names differ from the catalog.
  ('R-F', 'OEEV1-SWHL:Color Splash:1', ARRAY['Grogu'], ARRAY['Star Wars'], 'Holiday Vol.2', 'OEEV1-SWHL', 'Color Splash', 'Open Event Edition', 1, false, false, '2025', 10),
  -- no character: nothing.
  ('R-G', 'NOCHAR:Standard:1', ARRAY[]::text[], ARRAY['X'], 'Some Set', 'NOCHAR', 'Standard', 'Open Edition', 1, false, false, '2026', 5);

INSERT INTO public.pinnacle_editions (id, edition_key, character_name, franchise, set_name, variant_type)
VALUES ('LEEV2-FIND:Radiant Chrome:1', 'LEEV2-FIND:Radiant Chrome:1', 'Unknown', 'Unknown', 'Unknown', 'Radiant Chrome'),
       ('OEEV1-SWHL:Color Splash:1', 'OEEV1-SWHL:Color Splash:1', 'Stormtrooper', 'Star Wars', 'Holiday Vol.1', 'Color Splash');

SELECT _assert_eq(public.pinnacle_editions_fill_from_catalog()::text, '{"inserted": 2, "repaired": 1}', 'first run: 2 keys inserted, 1 stub repaired');

-- 1 + 2
SELECT _assert_eq(
  (SELECT character_name || '|' || set_name || '|' || edition_type || '|' || coalesce(mint_count::text, 'NULL') || '|' || is_serialized::text || '|' || series_year::text
     FROM public.pinnacle_editions WHERE id = 'LGEV4-TOYS:Apex:1'),
  'Bo Peep|Toy Story Vol.4|Legendary Edition|1|true|2026', 'catalog-only key: lowest render_id, trimmed set, agreeing mint');
SELECT _assert_eq(
  (SELECT coalesce(mint_count::text, 'NULL') FROM public.pinnacle_editions WHERE id = 'OEV1-X:Standard:1'),
  'NULL', 'renders that disagree on mint count give NULL, never a guess');

-- 3
SELECT _assert_eq(
  (SELECT character_name || '|' || franchise || '|' || set_name FROM public.pinnacle_editions WHERE id = 'LEEV2-FIND:Radiant Chrome:1'),
  'Dory|Finding Nemo|Finding Nemo Vol.2', 'a stub gets the catalog names');
SELECT _assert_eq(
  (SELECT character_name || '|' || set_name FROM public.pinnacle_editions WHERE id = 'OEEV1-SWHL:Color Splash:1'),
  'Stormtrooper|Holiday Vol.1', 'a real row is never overwritten');

-- 4
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_editions WHERE id = 'NOCHAR:Standard:1'), '0', 'no character, no row');

-- 5
SELECT _assert_eq(public.pinnacle_editions_fill_from_catalog()::text, '{"inserted": 0, "repaired": 0}', 'second run writes nothing');

ROLLBACK;
