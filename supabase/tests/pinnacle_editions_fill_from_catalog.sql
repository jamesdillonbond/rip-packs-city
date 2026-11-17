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
--   5. Idempotent: a second run reports inserted 0, repaired 0, thumbnails 0.
--   6. A NULL or placeholder thumbnail gets its OWN render's resolver URL only
--      when exactly one render matches (key, character); several matches are
--      left alone, and a real thumbnail is never touched.
--   7. Every catalog character gets a players row via the helper, franchise =
--      its most common first franchise with ™ stripped; existing rows are left
--      alone, and the reported count is rows WRITTEN.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926193316_audit_20260926_every_pinnacle_catalog_character_gets_a_page.sql).
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
  thumbnail_url text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.players (external_id text UNIQUE, collection_id uuid, name text NOT NULL, team text);
-- The helper, stubbed (it is pinned in its own file): insert unless the name exists.
CREATE FUNCTION public.pinnacle_ensure_character_player(p_name text, p_team text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO public.players (external_id, collection_id, name, team)
  SELECT 'disney_pinnacle-' || lower(btrim(p_name)), '7dd9dd11-e8b6-45c4-ac99-71331f959714', btrim(p_name), p_team
  WHERE btrim(p_name) <> '' AND lower(btrim(p_name)) <> 'unknown'
    AND NOT EXISTS (SELECT 1 FROM public.players x WHERE lower(x.name) = lower(btrim(p_name)))
$$;

CREATE OR REPLACE FUNCTION public.pinnacle_editions_fill_from_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_repaired integer;
  v_thumbs   integer;
  v_before   integer;
  v_chars    integer;
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

  -- (3) Thumbnails (20260926 follow-up). A row whose thumbnail is NULL or the
  -- contract's generic placeholder gets the resolver URL of its OWN render —
  -- only when exactly ONE catalog render under the key carries the row's
  -- character. Several renders of one character under a set-level key (e.g. a
  -- royalty code shared by two sets) is left alone rather than guessed.
  WITH one AS (
    SELECT pe.id, min(pc.render_id) AS render_id
    FROM public.pinnacle_editions pe
    JOIN public.pinnacle_catalog pc
      ON pc.legacy_edition_key = pe.id
     AND lower(btrim(pc.characters[1])) = lower(btrim(pe.character_name))
    WHERE pe.thumbnail_url IS NULL
       OR btrim(pe.thumbnail_url) = ''
       OR pe.thumbnail_url LIKE '%/on-chain/pinnacle.jpg%'
    GROUP BY pe.id
    HAVING count(*) = 1
  )
  UPDATE public.pinnacle_editions pe
     SET thumbnail_url = '/api/public/pinnacle-image/' || one.render_id,
         updated_at    = now()
    FROM one
   WHERE one.id = pe.id
     AND one.render_id ~ '^[A-Za-z0-9-]{3,64}$';
  GET DIAGNOSTICS v_thumbs = ROW_COUNT;

  -- (4) Characters (20260926 follow-up). Every character the catalog's
  -- Characters trait names gets its players row — the page is
  -- /disney-pinnacle/player/<slug>, and it lists that character's pins from the
  -- catalog. Only characters reached by pinnacle_editions had one (266 of 508
  -- catalog characters had no page). Franchise = the character's most common
  -- first franchise, with trademark symbols stripped ("Star Wars™" is
  -- "Star Wars" everywhere else). pinnacle_ensure_character_player never
  -- overwrites, skips 'Unknown', and dedupes by slug. The count is rows
  -- WRITTEN (players before vs after), not calls made.
  SELECT count(*) INTO v_before FROM public.players
   WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid;
  PERFORM public.pinnacle_ensure_character_player(c.n, c.team)
  FROM (
    SELECT btrim(ch) AS n,
           mode() WITHIN GROUP (ORDER BY NULLIF(btrim(regexp_replace(pc.franchises[1], '[™®©]', '', 'g')), '')) AS team
    FROM public.pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.characters) AS ch
    WHERE btrim(ch) <> ''
    GROUP BY btrim(ch)
    ORDER BY count(*) DESC, btrim(ch)
  ) c;
  SELECT count(*) - v_before INTO v_chars FROM public.players
   WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid;

  RETURN jsonb_build_object('inserted', v_inserted, 'repaired', v_repaired, 'thumbnails', v_thumbs, 'characters', v_chars);
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

INSERT INTO public.pinnacle_catalog VALUES
  ('R-DIN', 'DJAR:Standard:1', ARRAY['Din Djarin'], ARRAY['Star Wars™'], 'Mando Vol.1', 'GROG', 'Standard', 'Open Edition', 1, false, false, '2025', 900);
INSERT INTO public.players (external_id, collection_id, name, team)
VALUES ('disney_pinnacle-moana', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'Moana', 'Pre-existing');

INSERT INTO public.pinnacle_editions (id, edition_key, character_name, franchise, set_name, variant_type)
VALUES ('LEEV2-FIND:Radiant Chrome:1', 'LEEV2-FIND:Radiant Chrome:1', 'Unknown', 'Unknown', 'Unknown', 'Radiant Chrome'),
       ('OEEV1-SWHL:Color Splash:1', 'OEEV1-SWHL:Color Splash:1', 'Stormtrooper', 'Star Wars', 'Holiday Vol.1', 'Color Splash');

-- 6's fixtures: a placeholder row with one matching render, a NULL row whose
-- character has TWO renders under the key, and a row with a real thumbnail.
INSERT INTO public.pinnacle_catalog VALUES
  ('OEV1-HERC-HADE-S2', 'HERC:Standard:1', ARRAY['Hades'], ARRAY['Hercules'], 'Hercules Vol.1', 'HERC', 'Standard', 'Open Edition', 1, false, false, '2025', 900),
  ('OEV1-TWIN-A-S2', 'TWIN:Standard:1', ARRAY['Stitch'], ARRAY['Lilo'], 'Twin Vol.1', 'TWIN', 'Standard', 'Open Edition', 1, false, false, '2025', 900),
  ('OEV1-TWIN-B-S2', 'TWIN:Standard:1', ARRAY['Stitch'], ARRAY['Lilo'], 'Twin Vol.2', 'TWIN', 'Standard', 'Open Edition', 1, false, false, '2025', 900),
  ('OEV1-REAL-X-S2', 'REAL:Standard:1', ARRAY['Moana'], ARRAY['Moana'], 'Real Vol.1', 'REAL', 'Standard', 'Open Edition', 1, false, false, '2025', 900);
INSERT INTO public.pinnacle_editions (id, edition_key, character_name, franchise, set_name, thumbnail_url)
VALUES ('HERC:Standard:1', 'HERC:Standard:1', 'Hades', 'Hercules', 'Hercules Vol.1', 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg'),
       ('TWIN:Standard:1', 'TWIN:Standard:1', 'Stitch', 'Lilo', 'Twin Vol.1', NULL),
       ('REAL:Standard:1', 'REAL:Standard:1', 'Moana', 'Moana', 'Real Vol.1', 'https://real.example/moana.png');

SELECT _assert_eq(
  (public.pinnacle_editions_fill_from_catalog() - 'thumbnails' - 'characters')::text,
  '{"inserted": 3, "repaired": 1}', 'first run: 3 catalog-only keys inserted (incl. the Din Djarin fixture), 1 stub repaired');

-- 6
SELECT _assert_eq((SELECT thumbnail_url FROM public.pinnacle_editions WHERE id = 'HERC:Standard:1'),
  '/api/public/pinnacle-image/OEV1-HERC-HADE-S2', 'the placeholder becomes the row''s own render');
SELECT _assert_eq((SELECT coalesce(thumbnail_url, 'NULL') FROM public.pinnacle_editions WHERE id = 'TWIN:Standard:1'),
  'NULL', 'two renders of one character under a key: left alone, never guessed');
SELECT _assert_eq((SELECT thumbnail_url FROM public.pinnacle_editions WHERE id = 'REAL:Standard:1'),
  'https://real.example/moana.png', 'a real thumbnail is never overwritten');

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
-- 7: characters. Seeded above: none existed except Moana below. Every other
-- catalog character got a row on the first run; the franchise drops the ™.
-- Din Djarin's ONLY pin carries "Star Wars™", so this passes only if the ™ is
-- stripped (a character with other pins could win the vote without it).
SELECT _assert_eq((SELECT team FROM public.players WHERE name = 'Din Djarin'), 'Star Wars', '™ stripped from the franchise');
SELECT _assert_eq((SELECT count(*)::text FROM public.players WHERE name = 'Bo Peep'), '1', 'a catalog character gets exactly one row');

SELECT _assert_eq(public.pinnacle_editions_fill_from_catalog()::text, '{"inserted": 0, "repaired": 0, "characters": 0, "thumbnails": 0}', 'second run writes nothing');
SELECT _assert_eq((SELECT team FROM public.players WHERE name = 'Moana'), 'Pre-existing', 'an existing row is never overwritten');

ROLLBACK;
