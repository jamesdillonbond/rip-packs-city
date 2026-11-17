-- DB invariant: Pinnacle holdings in wallet_moments_cache are NAMED BY THEIR PIN
-- (pinnacle_catalog by render_id), never by the set-level pinnacle_editions key.
--
-- Until 2026-09-27 backfill_pinnacle_wmc_metadata_from_editions filled
-- player_name from pinnacle_editions — one character per set+variant key, and
-- the literal 'Unknown' for a multi-character set. 769 held pins read "Unknown"
-- (the trophy picker showed Dolly that way) and ~31k read a different character
-- from the same set (a Yoda pin as "Chewbacca"). Claims:
--
--   1. an 'Unknown' row takes its pin's character ("Dolly");
--   2. a row carrying the set-level name is CORRECTED to its pin's character,
--      even though it was not NULL ("Chewbacca" -> "Yoda");
--   3. a multi-character pin reads as a list ("Simba, Timon & Pumbaa",
--      "Poe Dameron & BB-8"), trimmed;
--   4. a pin with no character (an object pin) reads as its title;
--   5. the writer never writes 'Unknown', even where the catalog has no row;
--   6. set_name / tier / mint_count still fill from the set-level key;
--   7. other collections and other wallets are untouched; a second run is a no-op.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260927164145_audit_20260927_pinnacle_multi_character_names_read_as_a_list.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  id bigserial PRIMARY KEY, wallet_address text, collection_id uuid, moment_id text,
  edition_key text, render_id text, player_name text, character_name text,
  set_name text, tier text, mint_count int);
CREATE TABLE public.pinnacle_editions (
  edition_key text PRIMARY KEY, character_name text, set_name text, variant_type text, mint_count int);
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, character_name text, characters text[]);

-- >>> BEGIN verbatim backfill_pinnacle_wmc_metadata_from_editions >>>
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pinnacle_collection_id uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_updated integer;
BEGIN
  -- Names come from the PIN (pinnacle_catalog by render_id), never from the
  -- set-level pinnacle_editions row: that table carries one character per set
  -- and the literal 'Unknown' for multi-character sets, which every pin in the
  -- set inherited. set_name / tier / mint_count stay set-level (correct grain).
  WITH src AS (
    SELECT w.id,
           pe.set_name     AS pe_set_name,
           pe.variant_type AS pe_tier,
           pe.mint_count   AS pe_mint_count,
           NULLIF(btrim(pc.character_name), '') AS pc_title,
           -- "Simba", "Poe Dameron & BB-8", "Simba, Timon & Pumbaa"; a pin
           -- with no character (an object/scene pin) reads as its title.
           COALESCE(
             CASE cardinality(ch.arr)
               WHEN 0 THEN NULL
               WHEN 1 THEN ch.arr[1]
               ELSE array_to_string(ch.arr[1:cardinality(ch.arr) - 1], ', ')
                    || ' & ' || ch.arr[cardinality(ch.arr)]
             END,
             NULLIF(btrim(pc.character_name), '')
           ) AS pc_player
      FROM public.wallet_moments_cache w
      LEFT JOIN public.pinnacle_editions pe ON pe.edition_key = w.edition_key
      LEFT JOIN public.pinnacle_catalog  pc ON pc.render_id   = w.render_id
      LEFT JOIN LATERAL (
        SELECT ARRAY(
          SELECT btrim(u.x)
            FROM unnest(pc.characters) WITH ORDINALITY AS u(x, o)
           WHERE btrim(u.x) <> ''
           ORDER BY u.o
        ) AS arr
      ) ch ON true
     WHERE w.collection_id = v_pinnacle_collection_id
       AND (p_wallet_address IS NULL OR w.wallet_address = p_wallet_address)
       AND (pe.edition_key IS NOT NULL OR pc.render_id IS NOT NULL)
  ),
  updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET character_name = COALESCE(s.pc_title, wmc.character_name),
           player_name    = COALESCE(s.pc_player, NULLIF(wmc.player_name, 'Unknown')),
           set_name       = COALESCE(wmc.set_name,   s.pe_set_name),
           tier           = COALESCE(wmc.tier,       s.pe_tier),
           mint_count     = COALESCE(wmc.mint_count, s.pe_mint_count)
      FROM src s
     WHERE wmc.id = s.id
       AND (
         (s.pc_title  IS NOT NULL AND wmc.character_name IS DISTINCT FROM s.pc_title) OR
         (s.pc_player IS NOT NULL AND wmc.player_name    IS DISTINCT FROM s.pc_player) OR
         wmc.player_name = 'Unknown' OR
         (wmc.set_name   IS NULL AND s.pe_set_name   IS NOT NULL) OR
         (wmc.tier       IS NULL AND s.pe_tier       IS NOT NULL) OR
         (wmc.mint_count IS NULL AND s.pe_mint_count IS NOT NULL)
       )
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
-- <<< END verbatim backfill_pinnacle_wmc_metadata_from_editions <<<

-- Set-level keys: one character per key, 'Unknown' for a multi-character set.
INSERT INTO public.pinnacle_editions VALUES
  ('PIX-OEV3-TOYS:Digital Display:1', 'Unknown',   ' Pixar • Toy Story Vol.3', 'Digital Display', 156),
  ('STAR-LEV1-SWPA:Standard:1',       'Chewbacca', 'Star Wars Vol.1',          'Standard',        299),
  ('WDAS-LEV2-LION:Standard:1',       'Unknown',   'The Lion King Vol.2',      'Standard',        299),
  ('PIX-LEV1-PTRE:Standard:1',        'Unknown',   'Pixar Treasures Vol.1',    'Standard',        500),
  ('STAR-LEV1-EP7S:Standard:1',       'Unknown',   'Force Awakens Vol.1',      'Standard',        333);

-- The pin catalog: characters[] = who is on the pin, character_name = its title.
INSERT INTO public.pinnacle_catalog VALUES
  ('OEV3-TOYS-DOLL-S5', 'Dolly',                ARRAY['Dolly']),
  ('LEV1-SWPA-YODA-S6', 'Master Yoda',          ARRAY['Yoda']),
  ('LEV2-LION-CARE-S6', 'Carefree Companions',  ARRAY['Simba ', 'Timon', 'Pumbaa']),
  ('LEV1-PTRE-CUP-S6',  'Piston Cup',           NULL),
  ('LEV1-EP7S-POBB-S6', 'Poe Dameron & BB-8',   ARRAY['Poe Dameron', 'BB-8']);

-- 7dd9dd11… is Pinnacle; aaaaaaaa… stands in for another collection.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key, render_id, player_name, character_name, set_name, tier, mint_count) VALUES
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm1', 'PIX-OEV3-TOYS:Digital Display:1', 'OEV3-TOYS-DOLL-S5', 'Unknown',   'Dolly', NULL, NULL, NULL),
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm2', 'STAR-LEV1-SWPA:Standard:1',       'LEV1-SWPA-YODA-S6', 'Chewbacca', NULL,    'Star Wars Vol.1', 'Standard', 299),
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm3', 'WDAS-LEV2-LION:Standard:1',       'LEV2-LION-CARE-S6', 'Unknown',   NULL,    NULL, NULL, NULL),
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm4', 'PIX-LEV1-PTRE:Standard:1',        'LEV1-PTRE-CUP-S6',  NULL,        NULL,    NULL, NULL, NULL),
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm5', 'STAR-LEV1-EP7S:Standard:1',       'LEV1-EP7S-POBB-S6', 'Unknown',   NULL,    NULL, NULL, NULL),
  -- no catalog row for this render: must not be named from the set-level key
  ('0xa', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm6', 'PIX-OEV3-TOYS:Digital Display:1', 'OEV3-TOYS-ZZZZ-S5', 'Unknown',   NULL,    NULL, NULL, NULL),
  -- another wallet: untouched by a wallet-scoped run
  ('0xb', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'm7', 'STAR-LEV1-SWPA:Standard:1',       'LEV1-SWPA-YODA-S6', 'Chewbacca', NULL,    NULL, NULL, NULL),
  -- another collection sharing a render-shaped id: never touched
  ('0xa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'm2', 'STAR-LEV1-SWPA:Standard:1',       'LEV1-SWPA-YODA-S6', 'LeBron James', NULL, NULL, NULL, NULL);

SELECT _assert_eq(public.backfill_pinnacle_wmc_metadata_from_editions('0xa')::text, '6', 'the six Pinnacle rows of wallet 0xa are updated');

SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm1' AND wallet_address = '0xa'), 'Dolly', '1: Unknown takes the pin''s character');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm2' AND collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND wallet_address = '0xa'), 'Yoda', '2: the set-level name is corrected, not kept because it was non-NULL');
SELECT _assert_eq((SELECT character_name FROM public.wallet_moments_cache WHERE moment_id = 'm2' AND collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND wallet_address = '0xa'), 'Master Yoda', '2: character_name is the pin title');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm3'), 'Simba, Timon & Pumbaa', '3: three characters read as a list, trimmed');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm5'), 'Poe Dameron & BB-8', '3: two characters joined with &');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm4'), 'Piston Cup', '4: an object pin reads as its title');
SELECT _assert((SELECT player_name IS NULL FROM public.wallet_moments_cache WHERE moment_id = 'm6'), '5: no catalog row -> NULL, never Unknown and never the set-level name');
SELECT _assert_eq((SELECT count(*)::text FROM public.wallet_moments_cache WHERE player_name = 'Unknown' AND wallet_address = '0xa'), '0', '5: no Unknown remains for the wallet');
SELECT _assert_eq((SELECT set_name || '|' || tier || '|' || mint_count FROM public.wallet_moments_cache WHERE moment_id = 'm1' AND wallet_address = '0xa'), ' Pixar • Toy Story Vol.3|Digital Display|156', '6: set-level fields still fill from the key');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm7'), 'Chewbacca', '7: another wallet untouched by a wallet-scoped run');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE collection_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'LeBron James', '7: another collection untouched');
SELECT _assert_eq(public.backfill_pinnacle_wmc_metadata_from_editions('0xa')::text, '0', '7: a second run is a no-op');
SELECT _assert_eq(public.backfill_pinnacle_wmc_metadata_from_editions(NULL)::text, '1', 'a NULL wallet covers every wallet (0xb''s row)');
SELECT _assert_eq((SELECT player_name FROM public.wallet_moments_cache WHERE moment_id = 'm7'), 'Yoda', 'the all-wallet run corrects 0xb');

ROLLBACK;
