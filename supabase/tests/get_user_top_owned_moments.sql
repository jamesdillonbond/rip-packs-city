-- DB invariant: public.get_user_top_owned_moments — the "Top Owned" grid on a
-- user's profile/dashboard. It reads across ALL of the user's saved wallets, so
-- three rules are load-bearing: it must gate cross-user reads, it must DEDUPE a
-- moment held under two wallets (not double-count it), and its image_url must fall
-- back through a ladder so a tile never renders blank.
--
-- Pins:
--   * auth.uid() set and <> p_user_id raises 42501 (a signed-in user cannot read
--     another user's holdings); anon (NULL uid) passes;
--   * only fmv_usd > 0 rows from the user's saved wallets, honoring the optional
--     league / collection filters;
--   * ROW_NUMBER dedupe per (moment_id, collection_id) keeps the HIGHER-fmv copy
--     (then freshest last_seen) — a moment seen under two wallets appears once;
--   * image_url COALESCE ladder: wmc.image_url -> edition thumbnail -> pinnacle
--     thumbnail (minus the placeholder) -> the Top Shot media URL;
--   * ordered by fmv DESC, capped at p_limit.
--   * PANINI (2026-09-28): cards under the Panini usernames the user LINKED
--     (saved_collector_identities) are offered — the walked profile, plus serials
--     seen under the username AFTER its last complete walk; a serial captured
--     BEFORE that walk and absent from it (sold) is not; BURNT is not; another
--     user's username is not. wallet_address is NULL (a username is not an
--     address), an uncatalogued card's fmv is NULL (never 0), and a league filter
--     or another collection's filter excludes the branch.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260929021709_audit_20260928_trophy_picker_offers_linked_panini_cards.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- auth.uid() stub driven by a transaction-local GUC ('' -> NULL = anonymous).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.auth_uid', true), '')::uuid
$$;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.saved_wallets (user_id uuid, wallet_addr text);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, thumbnail_url text,
  team_name text, jersey_number smallint);
CREATE TABLE public.pinnacle_editions (edition_key text, thumbnail_url text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, moment_id text, collection_id uuid, fmv_usd numeric,
  league text, last_seen_at timestamptz, serial_number int, mint_count int,
  tier text, image_url text, is_locked boolean, series_number int,
  edition_key text, character_name text, edition_name text, player_name text,
  set_name text);

-- Stub the serial-FMV estimator (pinned separately); shape only matters here.
-- Panini (2026-09-28): linked usernames, the walked profile, the serial index.
CREATE TABLE public.saved_collector_identities (
  user_id uuid, collection_id uuid, identity_kind text, identity_value text);
CREATE TABLE public.panini_user_holdings (
  username text, url_key text, psku text, serial_number int, mint_cap int,
  athlete text, cardset text, image_url text, last_seen_at timestamptz);
CREATE TABLE public.panini_card_serials (
  sku text, edition_external_id text, serial_number int, mint_cap int,
  owner text, captured_at timestamptz, serial_state text);
CREATE TABLE public.panini_collector_walks (username text, last_complete_at timestamptz);
CREATE TABLE public.panini_editions (
  external_id text, player_name text, set_name text, tier text, thumbnail_url text);
ALTER TABLE public.editions ADD COLUMN player_name text, ADD COLUMN set_name text,
  ADD COLUMN tier text, ADD COLUMN circulation_count int;
CREATE FUNCTION public.panini_asset_url(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              WHEN p LIKE 'https://%' THEN p
              ELSE 'https://assets.paniniamerica.net/catalog/product/' || p END $$;

CREATE FUNCTION public.serial_fmv_estimate(p_cid uuid, p_serial int, p_circ int, p_tier text, p_fmv numeric, p_conf text, p_edition_id uuid)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('est', p_fmv) $$;

-- >>> BEGIN verbatim get_user_top_owned_moments (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH user_wallets AS (
    SELECT DISTINCT wallet_addr FROM saved_wallets WHERE user_id = p_user_id
  ),
  filtered AS (
    SELECT wmc.*
    FROM wallet_moments_cache wmc
    JOIN user_wallets uw ON uw.wallet_addr = wmc.wallet_address
    WHERE wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
      AND (p_league IS NULL OR wmc.league = p_league)
      AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
  ),
  ranked AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (
        PARTITION BY f.moment_id, f.collection_id
        ORDER BY f.fmv_usd DESC NULLS LAST, f.last_seen_at DESC
      ) AS rn
    FROM filtered f
  ),
  wallet_rows AS (
    SELECT
      r.moment_id AS o_moment_id, r.collection_id AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      r.wallet_address AS o_wallet_address,
      r.player_name AS o_player_name, r.set_name AS o_set_name, r.tier AS o_tier,
      r.serial_number AS o_serial_number, r.mint_count AS o_mint_count,
      r.fmv_usd AS o_fmv_usd,
      COALESCE(
        r.image_url,
        e.thumbnail_url,
        NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg'),
        CASE
          WHEN c.slug = 'nba_top_shot' THEN
            'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
          ELSE NULL
        END
      ) AS o_image_url,
      r.is_locked AS o_is_locked, r.series_number AS o_series_number, r.edition_key AS o_edition_key,
      r.character_name AS o_character_name, r.edition_name AS o_edition_name, r.league AS o_league,
      public.serial_fmv_estimate(r.collection_id, r.serial_number, r.mint_count, r.tier, sf.fmv_usd, sf.confidence::text, e.id) AS o_serial_fmv,
      e.team_name AS o_team_name,
      e.jersey_number::integer AS o_jersey_number
    FROM ranked r
    LEFT JOIN collections c ON c.id = r.collection_id
    LEFT JOIN editions e
      ON e.collection_id = r.collection_id
     AND e.external_id = r.edition_key
    LEFT JOIN pinnacle_editions pe
      ON c.slug = 'disney_pinnacle'
     AND pe.edition_key = r.edition_key
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) sf ON true
    WHERE r.rn = 1
  ),
  panini_names AS (
    SELECT DISTINCT sci.identity_value AS username
    FROM saved_collector_identities sci
    WHERE sci.user_id = p_user_id
      AND sci.collection_id = v_panini
      AND sci.identity_kind = 'username'
      AND p_league IS NULL
      AND (p_collection_id IS NULL OR p_collection_id = v_panini)
  ),
  panini_seen AS (
    -- (a) the walked public profile
    SELECT h.url_key AS sku, COALESCE(s.edition_external_id, h.psku) AS ed_key,
           COALESCE(h.serial_number, s.serial_number) AS serial, COALESCE(h.mint_cap, s.mint_cap) AS cap,
           h.athlete, h.cardset, h.image_url AS img, h.last_seen_at AS seen_at
    FROM panini_names pn
    JOIN panini_user_holdings h ON h.username = pn.username
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
    WHERE COALESCE(s.serial_state, '') <> 'BURNT'
    UNION ALL
    -- (b) serials seen under the username since its last complete walk
    SELECT s.sku, s.edition_external_id, s.serial_number, s.mint_cap,
           NULL::text, NULL::text, NULL::text, s.captured_at
    FROM panini_names pn
    JOIN panini_card_serials s ON s.owner <> '' AND lower(s.owner) = pn.username
    LEFT JOIN panini_collector_walks w ON w.username = pn.username
    WHERE COALESCE(s.serial_state, '') <> 'BURNT'
      AND (w.last_complete_at IS NULL OR s.captured_at > w.last_complete_at)
      AND NOT EXISTS (
        SELECT 1 FROM panini_user_holdings h2
        WHERE h2.username = pn.username AND h2.url_key = s.sku
      )
  ),
  panini_dedup AS (
    SELECT DISTINCT ON (ps.sku) ps.*
    FROM panini_seen ps
    ORDER BY ps.sku, ps.seen_at DESC NULLS LAST
  ),
  panini_rows AS (
    SELECT
      d.sku AS o_moment_id, v_panini AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      NULL::text AS o_wallet_address,
      COALESCE(e.player_name, pe.player_name, d.athlete) AS o_player_name,
      COALESCE(e.set_name, pe.set_name, d.cardset) AS o_set_name,
      COALESCE(e.tier::text, pe.tier::text) AS o_tier,
      d.serial AS o_serial_number,
      COALESCE(d.cap, e.circulation_count) AS o_mint_count,
      sf.fmv_usd AS o_fmv_usd,
      COALESCE(public.panini_asset_url(d.img), e.thumbnail_url, public.panini_asset_url(pe.thumbnail_url)) AS o_image_url,
      false AS o_is_locked, NULL::integer AS o_series_number, d.ed_key AS o_edition_key,
      NULL::text AS o_character_name, NULL::text AS o_edition_name, NULL::text AS o_league,
      public.serial_fmv_estimate(v_panini, d.serial, COALESCE(d.cap, e.circulation_count), e.tier::text, sf.fmv_usd, sf.confidence::text, e.id) AS o_serial_fmv,
      e.team_name AS o_team_name,
      e.jersey_number::integer AS o_jersey_number
    FROM panini_dedup d
    LEFT JOIN collections c ON c.id = v_panini
    LEFT JOIN editions e
      ON e.collection_id = v_panini
     AND e.external_id = d.ed_key
    LEFT JOIN panini_editions pe ON pe.external_id = d.ed_key
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) sf ON true
  ),
  all_rows AS (
    SELECT * FROM wallet_rows
    UNION ALL
    SELECT * FROM panini_rows
  )
  SELECT
    a.o_moment_id, a.o_collection_id, a.o_collection_slug, a.o_wallet_address,
    a.o_player_name, a.o_set_name, a.o_tier, a.o_serial_number, a.o_mint_count,
    a.o_fmv_usd, a.o_image_url, a.o_is_locked, a.o_series_number, a.o_edition_key,
    a.o_character_name, a.o_edition_name, a.o_league, a.o_serial_fmv,
    a.o_team_name, a.o_jersey_number
  FROM all_rows a
  ORDER BY a.o_fmv_usd DESC NULLS LAST, a.o_serial_number ASC NULLS LAST, a.o_moment_id
  LIMIT p_limit;
END;
$function$;
-- <<< END verbatim get_user_top_owned_moments <<<

\set U1 '''10000000-0000-0000-0000-000000000001'''
\set U2 '''20000000-0000-0000-0000-000000000002'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set PAN '''d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'''
\set eK1 '''aaaaaaaa-0000-0000-0000-0000000000k1'''

INSERT INTO public.collections (id, slug) VALUES (:TS::uuid, 'nba_top_shot'), (:PIN::uuid, 'disney_pinnacle'), (:PAN::uuid, 'panini_blockchain');
INSERT INTO public.saved_wallets (user_id, wallet_addr) VALUES (:U1::uuid,'wA'), (:U1::uuid,'wB'), (:U2::uuid,'wZ');

INSERT INTO public.editions (id, collection_id, external_id, thumbnail_url, team_name, jersey_number) VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid, :TS::uuid, 'k1', 'https://edimg/k1', 'Blazers', 0),
  ('22222222-2222-2222-2222-222222222222'::uuid, :TS::uuid, 'k2', 'https://edimg/k2', 'Blazers', 7);
  -- k4 has NO editions row (drives the Top Shot media fallback); pk1 is Pinnacle.
INSERT INTO public.pinnacle_editions (edition_key, thumbnail_url) VALUES ('pk1', 'https://pin/pk1');

-- m1 held under BOTH wA (fmv100) and wB (fmv90) -> dedupe keeps wA.
INSERT INTO public.wallet_moments_cache
  (wallet_address, moment_id, collection_id, fmv_usd, league, last_seen_at, serial_number, mint_count, tier, image_url, is_locked, series_number, edition_key, character_name, edition_name, player_name, set_name) VALUES
  ('wA','m1',:TS::uuid, 100,'NBA', now()-interval '2 h', 5, 100, 'RARE',  NULL,               false, 4, 'k1', NULL, 'E1', 'Dame', 'Base'),
  ('wB','m1',:TS::uuid,  90,'NBA', now()-interval '1 h', 5, 100, 'RARE',  NULL,               false, 4, 'k1', NULL, 'E1', 'Dame', 'Base'),
  ('wA','m2',:TS::uuid,  50,'NBA', now()-interval '2 h', 3,  50, 'COMMON','https://custom/img',false, 4, 'k2', NULL, 'E2', 'Ant',  'Base'),
  ('wA','m3',:TS::uuid,   0,'NBA', now()-interval '2 h', 1,  10, 'COMMON',NULL,               false, 4, 'k3', NULL, 'E3', 'X',    'Base'),
  ('wA','m4',:TS::uuid,  30,'NFL', now()-interval '2 h', 2,  20, 'COMMON',NULL,               false, 4, 'k4', NULL, 'E4', 'Y',    'Base'),
  ('wA','m5',:PIN::uuid, 40,NULL,  now()-interval '2 h', 9,  99, 'CHASER',NULL,               false, 1, 'pk1','Mickey','E5', NULL, 'Pin');

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('11111111-1111-1111-1111-111111111111'::uuid, 100, 'HIGH', now());

-- Panini: U1 linked 'jdb', U2 linked 'other'.
INSERT INTO public.saved_collector_identities VALUES
  (:U1::uuid, :PAN::uuid, 'username', 'jdb'), (:U2::uuid, :PAN::uuid, 'username', 'other');
INSERT INTO public.panini_collector_walks VALUES ('jdb', now() - interval '2 h');
INSERT INTO public.editions (id, collection_id, external_id, thumbnail_url, player_name, set_name, tier, circulation_count) VALUES
  ('33333333-3333-3333-3333-333333333333'::uuid, :PAN::uuid, 'ed-cat', 'https://assets.paniniamerica.net/catalog/product/cat.png', 'Catalogued Player', 'Cat Set', 'LEGENDARY', 25);
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  ('33333333-3333-3333-3333-333333333333'::uuid, 60, 'MEDIUM', now());
INSERT INTO public.panini_user_holdings VALUES
  ('jdb',   'pc-1', 'ed-cat', 1, 25, 'Walk Name', 'Walk Set', 'https://assets.paniniamerica.net/catalog/product/p1.png', now() - interval '2 h'),
  ('jdb',   'pc-2', 'ed-unc', 3, 10, 'Uncat Player', 'Uncat Set', 'pack/p2.png', now() - interval '2 h'),
  ('jdb',   'pc-3', 'ed-unc', 4, 10, 'Burnt Player', 'Uncat Set', NULL, now() - interval '2 h'),
  ('other', 'pc-9', 'ed-unc', 9, 10, 'Other Player', 'Uncat Set', NULL, now() - interval '2 h');
INSERT INTO public.panini_card_serials VALUES
  ('pc-1', 'ed-cat', 1, 25, 'jdb', now(), 'AVAILABLE'),                          -- also walked: once, not twice
  ('pc-3', 'ed-unc', 4, 10, 'jdb', now(), 'BURNT'),                              -- burnt: excluded
  ('pc-4', 'ed-new', 7, 50, 'JDB', now() - interval '30 min', 'AVAILABLE'),      -- bought since the walk: offered
  ('pc-5', 'ed-new', 8, 50, 'jdb', now() - interval '5 h', 'AVAILABLE');         -- before the walk, not in it: sold

-- ── 1. cross-user guard ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM set_config('test.auth_uid', '20000000-0000-0000-0000-000000000002', true);
  BEGIN
    PERFORM * FROM public.get_user_top_owned_moments('10000000-0000-0000-0000-000000000001'::uuid);
    RAISE EXCEPTION 'guard did not fire';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;  -- expected
  END;
  PERFORM set_config('test.auth_uid', '', true);  -- back to anonymous for the rest
END $$;

-- ── 2. dedupe + fmv>0 + no-filter set = m1,m2,m4,m5 (m3 fmv=0 dropped) ────────
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) WHERE collection_id <> :PAN::uuid), '4', 'no-filter wallet set = 4 (m3 fmv=0 dropped, m1 deduped)');
-- top row is m1, and it is the HIGHER-fmv (wA) copy
SELECT _assert_eq((SELECT wallet_address FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) ORDER BY fmv_usd DESC NULLS LAST LIMIT 1), 'wA', 'dedupe keeps the higher-fmv (wA) copy of m1');

-- ── 3. image_url ladder ──────────────────────────────────────────────────────
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m1'), 'https://edimg/k1', 'm1 image -> edition thumbnail (wmc image null)');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m2'), 'https://custom/img', 'm2 image -> wmc.image_url wins');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m4'), 'https://assets.nbatopshot.com/media/m4/image?width=512', 'm4 image -> Top Shot media fallback (no edition row)');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m5'), 'https://pin/pk1', 'm5 image -> pinnacle thumbnail');

-- ── 4. league filter excludes m4 (NFL) ───────────────────────────────────────
-- NBA set = m1, m2 (m4 is NFL; m5 has a NULL league so an explicit =NBA filter drops it too)
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, 'NBA', NULL)), '2', 'league=NBA keeps only the NBA-tagged m1,m2 (NFL m4 + null-league m5 dropped)');

-- ── 5. collection filter -> only pinnacle m5 ─────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PIN::uuid)), '1', 'collection filter -> only m5');

-- ── 6. limit + fmv ordering ──────────────────────────────────────────────────
SELECT _assert_eq((SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL)), 'm1', 'limit 1 + fmv DESC -> m1');

-- ── 7. Panini: linked usernames only ─────────────────────────────────────────
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid)),
  'pc-1,pc-2,pc-4', 'Panini set = walked pc-1,pc-2 + post-walk pc-4 (burnt pc-3, sold pc-5, other user pc-9 excluded; pc-1 once)');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL)), '7', 'no-filter set = 4 wallet + 3 Panini');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) WHERE wallet_address IS NULL), '3', 'Panini rows carry NO wallet_address (a username is not an address)');
SELECT _assert_eq((SELECT player_name || '|' || set_name || '|' || fmv_usd::int || '|' || mint_count FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid) WHERE moment_id='pc-1'),
  'Catalogued Player|Cat Set|60|25', 'catalogued card: edition name/set + the edition''s latest fmv_snapshots FMV');
SELECT _assert_eq((SELECT coalesce(fmv_usd::text, 'NULL') || '|' || player_name || '|' || image_url FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid) WHERE moment_id='pc-2'),
  'NULL|Uncat Player|https://assets.paniniamerica.net/catalog/product/pack/p2.png', 'uncatalogued card: NULL fmv (never 0), walked name, absolute Panini art');
SELECT _assert_eq((SELECT string_agg(moment_id, ',') FROM public.get_user_top_owned_moments(:U2::uuid, 24, NULL, NULL)), 'pc-9', 'U2 sees only its own linked username');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments('30000000-0000-0000-0000-000000000003'::uuid, 24, NULL, NULL)), '0', 'no wallets, no usernames -> nothing');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, 'NBA', NULL) WHERE collection_id = :PAN::uuid), '0', 'a league filter excludes Panini');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PIN::uuid) WHERE collection_id = :PAN::uuid), '0', 'another collection filter excludes Panini');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY ord) FROM (SELECT moment_id, row_number() OVER () ord FROM public.get_user_top_owned_moments(:U1::uuid, 3, NULL, NULL)) x),
  'm1,pc-1,m2', 'one fmv-ordered list across both branches (m1 100, pc-1 60, m2 50)');

SELECT '✓ get_user_top_owned_moments: all assertions passed' AS result;

ROLLBACK;
