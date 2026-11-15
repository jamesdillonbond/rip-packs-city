-- 2026-11-15 (PT) — deep audit 2026-11-15 R153 / handoff §5: Candy and Panini
-- players split across spelling variants, so the player page showed a fraction of
-- the person's editions as the whole. get_player_editions picks ONE players row by
-- slug (LIMIT 1), so even accent-only pairs (same slug) showed one row's editions.
--
-- Same pattern as #139 (20260925212218): merge the duplicate row into the kept row
-- (editions re-pointed by player_id), back up everything, and register the dropped
-- spelling's slug as a player_name_aliases row where it differs from the kept slug,
-- so the old URL 308s and resolve_canonical_player / ensure_players_from_edition_names
-- stop re-minting it. Edition labels (editions.player_name) are NOT rewritten.
--
-- Pairs (rows read 2026-11-15 ~8:25 AM PT; each drop row has 0 aliases / relations /
-- identities / serial_fmv_pooled_player_effect / panini_bridge / badge_editions refs):
--   Candy  keep "Cal Ripken Jr."   (11)  drop "Cal Ripken Jr"     (5)  alias cal-ripken-jr
--   Candy  keep "CJ Abrams"        (25)  drop "C.J. Abrams"       (5)  alias c-j-abrams
--   Candy  keep "Jasson Domínguez" (16)  drop "Jasson Dominguez"  (4)  same slug
--   Candy  keep "MacKenzie Gore"   (5)   drop "MacKenzie  Gore"   (3)  same slug (double space)
--   Candy  keep "Yordan Alvarez"   (58)  drop "Yordan Álvarez"    (2)  same slug
--   Panini keep "PJ Washington Jr."(22)  drop "P.J. Washington Jr."(0) alias p-j-washington-jr-
--   Panini keep "Wang Zhizhi"      (7)   drop "Wang Zhi-zhi"      (0)  alias wang-zhi-zhi
-- (counts = editions by player_id.)
-- ⛔ NOT merged: Candy "Luis Garcia" (Houston Astros, 8 editions) and "Luis García"
-- (Washington Nationals, 3) are TWO players (Astros pitcher / Nationals infielder).
--
-- Revert (both parts): INSERT INTO players SELECT <cols> FROM audit_20261115_r153_players_backup;
-- UPDATE editions e SET player_id = b.player_id FROM audit_20261115_r153_editions_backup b
-- WHERE b.edition_id = e.id; DELETE FROM player_name_aliases WHERE note LIKE 'R153%'.

CREATE TABLE IF NOT EXISTS public.audit_20261115_r153_players_backup AS
  SELECT p.*, now() AS backed_up_at FROM public.players p WHERE false;
ALTER TABLE public.audit_20261115_r153_players_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261115_r153_players_backup FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.audit_20261115_r153_editions_backup (
  edition_id uuid PRIMARY KEY,
  player_id  uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261115_r153_editions_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261115_r153_editions_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  r RECORD;
  v_moved int;
  v_slug_keep text;
  v_slug_drop text;
  v_keep_name text;
  v_drop_name text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('3b8f3793-4fbf-431a-b3e8-a8c5398701e1'::uuid, '53c48f94-783f-4103-ac82-5d0ea5e3ba61'::uuid),  -- Cal Ripken Jr.
      ('4f3be33e-9f7b-4a30-937f-f99a282be2b8',       '828f1944-8480-426d-9e56-5822a359b0be'),        -- CJ Abrams
      ('d93bf0ae-2244-4bc2-a11a-6d77a8b3c010',       '392aa15e-1f53-4de3-bc17-0df8c8d400d3'),        -- Jasson Domínguez
      ('3a2a8f50-31d3-4e5e-8e89-77e511747158',       'b3044042-e149-4b2e-a319-d7cbdc6bc296'),        -- MacKenzie Gore
      ('3f5b95c5-c66b-4021-acbe-eb90f69595f4',       '8e0d7484-8644-43ef-b5c8-51c7b089e7ac'),        -- Yordan Alvarez
      ('dd086ab0-494b-480e-bf1c-c7c78ccede07',       '5df8dc05-9c89-4c6b-b36c-3555dffae082'),        -- PJ Washington Jr.
      ('c63c2d48-a5f5-4f78-ab57-30eb19c2851d',       '3119d930-a2ed-465f-8431-519799f5a65e')         -- Wang Zhizhi
    ) v(keep_id, drop_id)
  LOOP
    SELECT name INTO v_keep_name FROM public.players WHERE id = r.keep_id;
    SELECT name INTO v_drop_name FROM public.players WHERE id = r.drop_id;
    IF v_keep_name IS NULL THEN RAISE EXCEPTION 'R153: keep row % not found', r.keep_id; END IF;
    IF v_drop_name IS NULL THEN RAISE NOTICE 'R153: drop row % already gone', r.drop_id; CONTINUE; END IF;
    IF (SELECT collection_id FROM public.players WHERE id = r.keep_id)
       IS DISTINCT FROM (SELECT collection_id FROM public.players WHERE id = r.drop_id) THEN
      RAISE EXCEPTION 'R153: % and % are in different collections', v_keep_name, v_drop_name;
    END IF;
    IF EXISTS (SELECT 1 FROM public.player_name_aliases WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_relations WHERE player_id = r.drop_id OR related_player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_identities WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = r.drop_id::text) THEN
      RAISE EXCEPTION 'R153: "%" is referenced outside editions — extend the merge first', v_drop_name;
    END IF;
    INSERT INTO public.audit_20261115_r153_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = r.drop_id;
    INSERT INTO public.audit_20261115_r153_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = r.drop_id
      ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = r.keep_id WHERE player_id = r.drop_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    DELETE FROM public.players WHERE id = r.drop_id;
    v_slug_keep := regexp_replace(lower(trim(extensions.unaccent(v_keep_name))), '[^a-z0-9]+', '-', 'g');
    v_slug_drop := regexp_replace(lower(trim(extensions.unaccent(v_drop_name))), '[^a-z0-9]+', '-', 'g');
    IF v_slug_drop <> v_slug_keep THEN
      INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        SELECT p.collection_id, v_slug_drop, r.keep_id, 'R153 2026-11-15: source spelling "' || v_drop_name || '"'
          FROM public.players p WHERE p.id = r.keep_id
        ON CONFLICT (collection_id, alias_slug) DO NOTHING;
    END IF;
    RAISE NOTICE 'R153: merged "%" into "%" (% editions)', v_drop_name, v_keep_name, v_moved;
  END LOOP;
END $$;

-- Post-conditions.
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.players WHERE id IN (
    '53c48f94-783f-4103-ac82-5d0ea5e3ba61','828f1944-8480-426d-9e56-5822a359b0be','392aa15e-1f53-4de3-bc17-0df8c8d400d3',
    'b3044042-e149-4b2e-a319-d7cbdc6bc296','8e0d7484-8644-43ef-b5c8-51c7b089e7ac','5df8dc05-9c89-4c6b-b36c-3555dffae082',
    '3119d930-a2ed-465f-8431-519799f5a65e');
  IF v_n <> 0 THEN RAISE EXCEPTION 'R153: % dropped rows still exist', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.player_name_aliases WHERE note LIKE 'R153%';
  IF v_n < 4 THEN RAISE EXCEPTION 'R153: only % alias rows (expected 4)', v_n; END IF;
  -- the two Luis Garcías stay two rows
  SELECT count(*) INTO v_n FROM public.players WHERE id IN ('462c23be-48d9-4685-a01f-0b9e80510ba7','4ede4af0-b04e-41ac-8eac-14f6515fde7b');
  IF v_n <> 2 THEN RAISE EXCEPTION 'R153: a Luis Garcia row was touched'; END IF;
END $$;

-- ── Part 2: Panini national-team rows minted twice (found by the R153 probe) ──
-- 48 Panini names (Argentina, Brazil, … Bosnia-Herzegovina, DR Congo, IR Iran) exist as
-- TWO players rows with the same slug: a `panini_blockchain-<slug>` row minted by
-- ensure_players_from_edition_names on 2026-09-26, and a `panini-<slug>` row the Panini
-- bridge minted on 2026-10-03 (the bridge upserts by external_id, not by slug). Team
-- Badges editions are split between them (Argentina: Black/Gold on one row, Green/
-- Orange/Silver on the other), and get_player_editions shows one row's slice.
-- KEEP the bridge's `panini-` row (the bridge keeps writing it); move the 107 editions
-- off the 48 `panini_blockchain-` rows and delete those. Same slug ⇒ no alias needed,
-- and ensure_players_from_edition_names cannot re-mint (its slug test finds the kept row).
-- Read 2026-11-15 ~8:30 AM PT: 48 pairs, 0 aliases / relations / identities / bridge
-- candidates / pooled-effect refs on the drop rows.
DO $$
DECLARE r RECORD; v_moved int; v_total int := 0; v_pairs int := 0;
BEGIN
  FOR r IN
    WITH pc AS (
      SELECT id, name, external_id,
             regexp_replace(lower(trim(extensions.unaccent(name))), '[^a-z0-9]+', '-', 'g') AS slug
        FROM public.players WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b')
    SELECT d.id AS drop_id, k.id AS keep_id, d.name
      FROM pc d JOIN pc k ON k.slug = d.slug
     WHERE k.external_id LIKE 'panini-%' AND d.external_id LIKE 'panini_blockchain-%'
  LOOP
    IF EXISTS (SELECT 1 FROM public.player_name_aliases WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_relations WHERE player_id = r.drop_id OR related_player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.player_identities WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.serial_fmv_pooled_player_effect WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.panini_bridge_candidate_editions WHERE player_id = r.drop_id)
       OR EXISTS (SELECT 1 FROM public.badge_editions WHERE player_id = r.drop_id::text) THEN
      RAISE EXCEPTION 'R153 part 2: "%" is referenced outside editions — extend the merge first', r.name;
    END IF;
    INSERT INTO public.audit_20261115_r153_players_backup SELECT p.*, now() FROM public.players p WHERE p.id = r.drop_id;
    INSERT INTO public.audit_20261115_r153_editions_backup (edition_id, player_id)
      SELECT e.id, e.player_id FROM public.editions e WHERE e.player_id = r.drop_id
      ON CONFLICT (edition_id) DO NOTHING;
    UPDATE public.editions SET player_id = r.keep_id WHERE player_id = r.drop_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    DELETE FROM public.players WHERE id = r.drop_id;
    v_total := v_total + v_moved; v_pairs := v_pairs + 1;
  END LOOP;
  IF v_pairs NOT BETWEEN 40 AND 60 THEN
    RAISE EXCEPTION 'R153 part 2: % pairs (expected ~48) — re-read before applying', v_pairs;
  END IF;
  RAISE NOTICE 'R153 part 2: % Panini duplicate rows merged, % editions moved', v_pairs, v_total;
END $$;

DO $$
DECLARE v_n int;
BEGIN
  WITH pc AS (
    SELECT regexp_replace(lower(trim(extensions.unaccent(name))), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.players WHERE collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b')
  SELECT count(*) INTO v_n FROM (SELECT slug FROM pc GROUP BY slug HAVING count(*) > 1) x;
  IF v_n <> 0 THEN RAISE EXCEPTION 'R153 part 2: % Panini slugs still have more than one row', v_n; END IF;
END $$;
