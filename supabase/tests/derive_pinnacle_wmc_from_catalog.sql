-- DB invariant: public.derive_pinnacle_wmc_from_catalog — the hourly pass (run by
-- /api/cron/pinnacle-wmc-render-id after it resolves render_ids) that copies a pin's
-- catalog facts onto its wallet_moments_cache rows.
--
-- Pins:
--   * character_name / set_name / mint_count / image_url come from the catalog row
--     matched by render_id (Pinnacle rows only);
--   * player_name is FILLED (NULL or 'Unknown' only) with the pin's `characters` trait,
--     formatted as backfill_pinnacle_wmc_metadata_from_editions formats it — one name,
--     "A & B", "A, B & C" — falling back to character_name for a pin with no character;
--   * an existing player_name is never rewritten;
--   * a non-Pinnacle row with the same render_id is untouched;
--   * the return value is the number of rows updated, and a second run updates 0.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261019010856_audit_20261018_derive_pinnacle_wmc_fills_player_name.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  id serial PRIMARY KEY, collection_id uuid, moment_id text, render_id text,
  character_name text, set_name text, mint_count int, image_url text, player_name text);
CREATE TABLE public.pinnacle_catalog (
  render_id text, character_name text, characters text[], set_name text,
  total_minted int, thumbnail_url text);

-- >>> BEGIN verbatim derive_pinnacle_wmc_from_catalog (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.derive_pinnacle_wmc_from_catalog()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- 2026-10-18: player_name is FILLED here too (NULL or the literal 'Unknown' only,
  -- never rewritten). It is the pin's `characters` trait, formatted exactly as the
  -- canonical heal backfill_pinnacle_wmc_metadata_from_editions formats it ("Simba",
  -- "Poe Dameron & BB-8", "Simba, Timon & Pumbaa"; an object pin with no character
  -- reads as its character_name). Before this, a row whose render_id landed after the
  -- wallet post-pass got character_name here but player_name only from the daily
  -- 3:33 AM PT heal, up to ~21 h later (41 rows of one wallet, 10-18).
  UPDATE wallet_moments_cache w
  SET character_name = c.character_name,
      set_name       = c.set_name,
      mint_count     = COALESCE(c.total_minted, w.mint_count),
      image_url      = c.thumbnail_url,
      player_name    = CASE
                         WHEN w.player_name IS NULL OR w.player_name = 'Unknown'
                         THEN COALESCE(ch.player, w.player_name)
                         ELSE w.player_name
                       END
  FROM pinnacle_catalog c
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             CASE cardinality(a.arr)
               WHEN 0 THEN NULL
               WHEN 1 THEN a.arr[1]
               ELSE array_to_string(a.arr[1:cardinality(a.arr) - 1], ', ')
                    || ' & ' || a.arr[cardinality(a.arr)]
             END,
             NULLIF(btrim(c.character_name), '')
           ) AS player
      FROM (
        SELECT ARRAY(
          SELECT btrim(u.x)
            FROM unnest(c.characters) WITH ORDINALITY AS u(x, o)
           WHERE btrim(u.x) <> ''
           ORDER BY u.o
        ) AS arr
      ) a
  ) ch
  WHERE w.render_id = c.render_id
    AND w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    AND c.character_name IS NOT NULL
    AND (
      w.character_name IS DISTINCT FROM c.character_name
      OR w.set_name IS DISTINCT FROM c.set_name
      OR w.image_url IS DISTINCT FROM c.thumbnail_url
      OR w.mint_count IS DISTINCT FROM COALESCE(c.total_minted, w.mint_count)
      OR ((w.player_name IS NULL OR w.player_name = 'Unknown') AND ch.player IS NOT NULL)
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
-- <<< END verbatim derive_pinnacle_wmc_from_catalog <<<

\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set ts  '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.pinnacle_catalog VALUES
  ('R-ONE',   'Django',                 ARRAY['Django'],                      'Ratatouille Vol.2', 100, 'https://img/one'),
  ('R-TWO',   'Poe Dameron',            ARRAY['Poe Dameron', ' BB-8 '],       'Resistance',        50,  'https://img/two'),
  ('R-THREE', 'Simba',                  ARRAY['Simba', 'Timon', '', 'Pumbaa'],'Pride Rock',        NULL,'https://img/three'),
  ('R-OBJ',   'The Millennium Falcon',  ARRAY[]::text[],                      'Ships',             10,  'https://img/obj');

INSERT INTO public.wallet_moments_cache (collection_id, moment_id, render_id, player_name, mint_count) VALUES
  (:pin::uuid, 'm1', 'R-ONE',   NULL,          NULL),   -- fill
  (:pin::uuid, 'm2', 'R-TWO',   'Unknown',     NULL),   -- replace the literal Unknown
  (:pin::uuid, 'm3', 'R-THREE', NULL,          7),      -- three characters, empty one dropped; NULL total keeps 7
  (:pin::uuid, 'm4', 'R-OBJ',   NULL,          NULL),   -- no character: falls back to character_name
  (:pin::uuid, 'm5', 'R-ONE',   'Remy & Django', NULL), -- an existing name is NEVER rewritten
  (:ts::uuid,  'm6', 'R-ONE',   NULL,          NULL);   -- not Pinnacle: untouched

SELECT _assert_eq(public.derive_pinnacle_wmc_from_catalog()::text, '5', 'five Pinnacle rows updated, the Top Shot row not');

SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m1'), 'Django', 'NULL player_name filled from the characters trait');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m2'), 'Poe Dameron & BB-8', 'the literal Unknown replaced; two characters joined with &, trimmed');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m3'), 'Simba, Timon & Pumbaa', 'three characters: commas then &; the empty element dropped');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m4'), 'The Millennium Falcon', 'an object pin with no character reads as its character_name');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m5'), 'Remy & Django', 'an existing player_name is never rewritten');
SELECT _assert((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id='m6') IS NULL, 'a non-Pinnacle row is untouched');
SELECT _assert((SELECT character_name FROM public.wallet_moments_cache WHERE moment_id='m6') IS NULL, 'a non-Pinnacle row gets no catalog facts either');

SELECT _assert_eq((SELECT character_name || '|' || set_name || '|' || image_url FROM public.wallet_moments_cache WHERE moment_id='m1'), 'Django|Ratatouille Vol.2|https://img/one', 'catalog facts copied');
SELECT _assert_eq((SELECT mint_count::text FROM public.wallet_moments_cache WHERE moment_id='m1'), '100', 'mint_count from the catalog');
SELECT _assert_eq((SELECT mint_count::text FROM public.wallet_moments_cache WHERE moment_id='m3'), '7', 'a NULL catalog total keeps the row''s own mint_count');

SELECT _assert_eq(public.derive_pinnacle_wmc_from_catalog()::text, '0', 'idempotent: a second run updates nothing');

SELECT '✓ derive_pinnacle_wmc_from_catalog: all assertions passed' AS result;

ROLLBACK;
