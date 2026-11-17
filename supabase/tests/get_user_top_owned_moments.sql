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
--   * image_url: a Top Shot row ALWAYS gets the per-Moment media URL
--     (assets.nbatopshot.com/media/<id>/image?width=512) — its cached edition
--     HERO asset is dead for all of Series 1 (2026-11-06) — and every other
--     collection keeps the COALESCE ladder: wmc.image_url -> edition thumbnail
--     -> pinnacle thumbnail (minus the placeholder);
--   * p_query (2026-11-06): a typed name filters the WHOLE wallet server-side
--     (player / set / team / character / edition name, case-insensitive
--     substring, % and _ literal) in BOTH branches, before the fmv cap — the
--     picker's "search inside the top 96" defect; NULL / blank = no filter;
--     (2026-11-08) the query is split into words and EVERY word must appear in
--     SOME field — "Damian Lillard Extra Spice" spans player + set;
--   * p_offset (2026-11-08, "Load more"): pages the SAME total order (fmv,
--     serial, moment_id, collection_id); pages never overlap and their union is
--     the full list; NULL / negative = 0;
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
-- (supabase/migrations/20261108160555_audit_20261108_trophy_picker_load_more_offset.sql);
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
CREATE OR REPLACE FUNCTION public.get_user_top_owned_moments(p_user_id uuid, p_limit integer DEFAULT 24, p_league text DEFAULT NULL::text, p_collection_id uuid DEFAULT NULL::uuid, p_query text DEFAULT NULL::text, p_offset integer DEFAULT 0)
 RETURNS TABLE(moment_id text, collection_id uuid, collection_slug text, wallet_address text, player_name text, set_name text, tier text, serial_number integer, mint_count integer, fmv_usd numeric, image_url text, is_locked boolean, series_number integer, edition_key text, character_name text, edition_name text, league text, serial_fmv jsonb, team_name text, jersey_number integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  -- A typed query is split into WORDS; EVERY word must appear (case-insensitive
  -- substring) somewhere in the row's searchable fields, in any field — so
  -- "Damian Lillard Extra Spice" finds the Lillard whose SET is Extra Spice
  -- (2026-11-08). % and _ in the input are literal characters, never wildcards.
  -- NULL / blank = no name filter.
  v_words text[] := CASE
    WHEN p_query IS NULL OR btrim(p_query) = '' THEN NULL
    ELSE ARRAY(
      SELECT '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      FROM regexp_split_to_table(btrim(p_query), '\s+') AS w
    )
  END;
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
      CASE
        -- Top Shot: the per-Moment media URL serves for every Moment; the cached
        -- edition HERO asset is dead for all of Series 1 (2026-11-06).
        WHEN c.slug = 'nba_top_shot' THEN
          'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
        ELSE COALESCE(
          r.image_url,
          e.thumbnail_url,
          NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg')
        )
      END AS o_image_url,
      r.is_locked AS o_is_locked, r.series_number AS o_series_number, r.edition_key AS o_edition_key,
      r.character_name AS o_character_name, r.edition_name AS o_edition_name, r.league AS o_league,
      e.team_name AS o_team_name,
      e.jersey_number::integer AS o_jersey_number,
      -- 2026-11-10: the serial-FMV inputs ride along; the estimate (and the latest-snapshot read it needs) is
      -- computed only for the returned page, below. Computed per row here it cost a whale's first load
      -- 47,625 laterals + estimates (517k buffers) to return 24 rows.
      'w'::text AS k_kind, e.id AS k_eid, r.tier AS k_tier, NULL::numeric AS k_sf_fmv, NULL::text AS k_sf_conf
    FROM ranked r
    LEFT JOIN collections c ON c.id = r.collection_id
    LEFT JOIN editions e
      ON e.collection_id = r.collection_id
     AND e.external_id = r.edition_key
    LEFT JOIN pinnacle_editions pe
      ON c.slug = 'disney_pinnacle'
     AND pe.edition_key = r.edition_key
    WHERE r.rn = 1
      AND (v_words IS NULL
           OR concat_ws(' ', r.player_name, r.set_name, e.team_name, r.character_name, r.edition_name) ILIKE ALL (v_words))
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
  -- HOLDINGS NAMED FIRST (2026-11-09, #243): a held card's edition is its own psku
  -- (measured over all 43,182 holdings: psku never NULL, and panini_card_serials'
  -- edition_external_id never differs from it), so the words are matched on the
  -- psku's edition joins BEFORE the per-card panini_card_serials lookup — the
  -- cold cost of a big profile (6,023 index probes into a 9.3 GB table, ~10k
  -- blocks, ~14 s of rigged's 16 s "Damian Lillard" read). panini_named still
  -- applies the same filter on the final key, so a survivor's row is unchanged.
  panini_held AS MATERIALIZED (
    SELECT h.*
    FROM panini_names pn
    JOIN panini_user_holdings h ON h.username = pn.username
    LEFT JOIN editions e0
      ON e0.collection_id = v_panini
     AND e0.external_id = h.psku
    LEFT JOIN panini_editions pe0 ON pe0.external_id = h.psku
    WHERE (v_words IS NULL
           OR concat_ws(' ', COALESCE(e0.player_name, pe0.player_name, h.athlete),
                             COALESCE(e0.set_name, pe0.set_name, h.cardset),
                             e0.team_name) ILIKE ALL (v_words))
  ),
  panini_seen AS (
    -- (a) the walked public profile
    SELECT h.url_key AS sku, COALESCE(s.edition_external_id, h.psku) AS ed_key,
           COALESCE(h.serial_number, s.serial_number) AS serial, COALESCE(h.mint_cap, s.mint_cap) AS cap,
           h.athlete, h.cardset, h.image_url AS img, h.last_seen_at AS seen_at
    FROM panini_held h
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
  -- NAME FILTER FIRST (2026-11-08, Dame Time): the words are matched on the
  -- cheap edition joins BEFORE the per-card latest-FMV lateral and
  -- serial_fmv_estimate run. Filtering after them made a 6,023-card Panini
  -- profile (rigged) run 22-31 s for "Damian Lillard" -- past the route's 8 s
  -- read budget and this function's own 8 s statement_timeout -- so the picker
  -- answered "Couldn't load your Moments". MATERIALIZED keeps the filter from
  -- being planned after the lateral again.
  panini_named AS MATERIALIZED (
    SELECT
      d.sku, d.ed_key, d.serial, d.cap, d.img,
      e.id AS e_id, e.tier::text AS e_tier, e.circulation_count AS e_circ,
      e.thumbnail_url AS e_thumb, e.team_name AS e_team, e.jersey_number AS e_jersey,
      COALESCE(e.player_name, pe.player_name, d.athlete) AS n_player,
      COALESCE(e.set_name, pe.set_name, d.cardset) AS n_set,
      COALESCE(e.tier::text, pe.tier::text) AS n_tier,
      pe.thumbnail_url AS pe_thumb
    FROM panini_dedup d
    LEFT JOIN editions e
      ON e.collection_id = v_panini
     AND e.external_id = d.ed_key
    LEFT JOIN panini_editions pe ON pe.external_id = d.ed_key
    WHERE (v_words IS NULL
           OR concat_ws(' ', COALESCE(e.player_name, pe.player_name, d.athlete),
                             COALESCE(e.set_name, pe.set_name, d.cardset),
                             e.team_name) ILIKE ALL (v_words))
  ),
  panini_rows AS (
    SELECT
      n.sku AS o_moment_id, v_panini AS o_collection_id, c.slug::TEXT AS o_collection_slug,
      NULL::text AS o_wallet_address,
      n.n_player AS o_player_name,
      n.n_set AS o_set_name,
      n.n_tier AS o_tier,
      n.serial AS o_serial_number,
      COALESCE(n.cap, n.e_circ) AS o_mint_count,
      sf.fmv_usd AS o_fmv_usd,
      COALESCE(public.panini_asset_url(n.img), n.e_thumb, public.panini_asset_url(n.pe_thumb)) AS o_image_url,
      false AS o_is_locked, NULL::integer AS o_series_number, n.ed_key AS o_edition_key,
      NULL::text AS o_character_name, NULL::text AS o_edition_name, NULL::text AS o_league,
      n.e_team AS o_team_name,
      n.e_jersey::integer AS o_jersey_number,
      -- Panini's latest snapshot is already read here (it IS o_fmv_usd, the sort key); carried, not re-read.
      'p'::text AS k_kind, n.e_id AS k_eid, n.e_tier AS k_tier, sf.fmv_usd AS k_sf_fmv, sf.confidence::text AS k_sf_conf
    FROM panini_named n
    LEFT JOIN collections c ON c.id = v_panini
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence
      FROM fmv_snapshots fs
      WHERE fs.edition_id = n.e_id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) sf ON true
  ),
  all_rows AS (
    SELECT * FROM wallet_rows
    UNION ALL
    SELECT * FROM panini_rows
  ),
  -- collection_id breaks the last tie: a moment_id is unique only WITHIN a
  -- collection, and "Load more" pages with OFFSET, so the order must be total
  -- or a row can repeat on one page and vanish from the next (2026-11-08).
  -- 2026-11-10: the page is cut FIRST (MATERIALIZED, so the estimate below cannot be planned before it).
  page AS MATERIALIZED (
    SELECT a.*
    FROM all_rows a
    ORDER BY a.o_fmv_usd DESC NULLS LAST, a.o_serial_number ASC NULLS LAST, a.o_moment_id, a.o_collection_id
    LIMIT p_limit
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT
    a.o_moment_id, a.o_collection_id, a.o_collection_slug, a.o_wallet_address,
    a.o_player_name, a.o_set_name, a.o_tier, a.o_serial_number, a.o_mint_count,
    a.o_fmv_usd, a.o_image_url, a.o_is_locked, a.o_series_number, a.o_edition_key,
    a.o_character_name, a.o_edition_name, a.o_league,
    public.serial_fmv_estimate(a.o_collection_id, a.o_serial_number, a.o_mint_count, a.k_tier,
                               CASE WHEN a.k_kind = 'w' THEN sw.fmv_usd ELSE a.k_sf_fmv END,
                               CASE WHEN a.k_kind = 'w' THEN sw.confidence::text ELSE a.k_sf_conf END,
                               a.k_eid) AS o_serial_fmv,
    a.o_team_name, a.o_jersey_number
  FROM page a
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd, fs.confidence
    FROM fmv_snapshots fs
    WHERE a.k_kind = 'w' AND fs.edition_id = a.k_eid
    ORDER BY fs.computed_at DESC
    LIMIT 1
  ) sw ON true
  ORDER BY a.o_fmv_usd DESC NULLS LAST, a.o_serial_number ASC NULLS LAST, a.o_moment_id, a.o_collection_id;
END;
$function$;
-- <<< END verbatim get_user_top_owned_moments <<<

\set U1 '''10000000-0000-0000-0000-000000000001'''
\set U2 '''20000000-0000-0000-0000-000000000002'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set PAN '''d1a0a7f5-609a-49f4-a1a7-4eaac55b020b'''
\set AD '''b7a9c2e1-5d3f-4a8b-9c6e-2f1d8e7a6b5c'''
\set eK1 '''aaaaaaaa-0000-0000-0000-0000000000k1'''

INSERT INTO public.collections (id, slug) VALUES (:TS::uuid, 'nba_top_shot'), (:PIN::uuid, 'disney_pinnacle'), (:PAN::uuid, 'panini_blockchain'), (:AD::uuid, 'nfl_all_day');
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
  ('wA','m5',:PIN::uuid, 40,NULL,  now()-interval '2 h', 9,  99, 'CHASER',NULL,               false, 1, 'pk1','Mickey','E5', NULL, 'Pin'),
  -- m6: NOT Top Shot, with a cached image -> the ladder still lets wmc.image_url win.
  ('wA','m6',:AD::uuid,  20,'NFL', now()-interval '2 h', 8,  80, 'RARE',  'https://custom/ad', false, 1, 'k6', NULL, 'E6', 'Amon-Ra St. Brown', 'Rookie Revelation'),
  -- m7: Top Shot whose cached image is a DEAD Series-1 edition hero asset (2026-11-06).
  ('wA','m7',:TS::uuid,  10,'NBA', now()-interval '2 h', 12, 49, 'LEGENDARY','https://assets.nbatopshot.com/editions/1_cosmic_legendary/f2a3c763/play_f2a3c763_1_cosmic_legendary_capture_Hero_2880_2880_Transparent.png', false, 0, 'k7', NULL, 'E7', 'Damian Lillard', 'Cosmic');

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

-- ── 2. dedupe + fmv>0 + no-filter set = m1,m2,m4,m5,m6,m7 (m3 fmv=0 dropped) ──
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) WHERE collection_id <> :PAN::uuid), '6', 'no-filter wallet set = 6 (m3 fmv=0 dropped, m1 deduped)');
-- top row is m1, and it is the HIGHER-fmv (wA) copy
SELECT _assert_eq((SELECT wallet_address FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) ORDER BY fmv_usd DESC NULLS LAST LIMIT 1), 'wA', 'dedupe keeps the higher-fmv (wA) copy of m1');

-- ── 3. image_url: Top Shot = media URL always; other collections = the ladder ─
-- ⚠ 2026-11-06 INVERSION (not a re-pin): m1 and m2 are Top Shot, and the ladder
-- used to hand them the edition thumbnail / the cached wmc image. The cached
-- Series-1 hero assets 404 (Trevor's Dame Cosmic #12/49), so a Top Shot row now
-- gets the per-Moment media URL whatever the cache holds; m6 (All Day) keeps the
-- "wmc.image_url wins" promise alive for every collection that is not Top Shot.
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m1'), 'https://assets.nbatopshot.com/media/m1/image?width=512', 'm1 (Top Shot, wmc image null) -> media URL, NOT the edition thumbnail');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m2'), 'https://assets.nbatopshot.com/media/m2/image?width=512', 'm2 (Top Shot, cached image) -> media URL, the cache is not consulted');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m7'), 'https://assets.nbatopshot.com/media/m7/image?width=512', 'm7 (Top Shot, DEAD Series-1 hero cached) -> media URL');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m4'), 'https://assets.nbatopshot.com/media/m4/image?width=512', 'm4 image -> Top Shot media URL (no edition row)');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m6'), 'https://custom/ad', 'm6 (All Day) image -> wmc.image_url wins (the ladder is unchanged off Top Shot)');
SELECT _assert_eq((SELECT image_url FROM public.get_user_top_owned_moments(:U1::uuid,24,NULL,NULL) WHERE moment_id='m5'), 'https://pin/pk1', 'm5 image -> pinnacle thumbnail');

-- ── 4. league filter excludes m4 (NFL) ───────────────────────────────────────
-- NBA set = m1, m2, m7 (m4/m6 are NFL; m5 has a NULL league so an explicit =NBA filter drops it too)
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, 'NBA', NULL)), '3', 'league=NBA keeps only the NBA-tagged m1,m2,m7 (NFL m4,m6 + null-league m5 dropped)');

-- ── 5. collection filter -> only pinnacle m5 ─────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PIN::uuid)), '1', 'collection filter -> only m5');

-- ── 6. limit + fmv ordering ──────────────────────────────────────────────────
SELECT _assert_eq((SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL)), 'm1', 'limit 1 + fmv DESC -> m1');

-- ── 7. Panini: linked usernames only ─────────────────────────────────────────
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid)),
  'pc-1,pc-2,pc-4', 'Panini set = walked pc-1,pc-2 + post-walk pc-4 (burnt pc-3, sold pc-5, other user pc-9 excluded; pc-1 once)');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL)), '9', 'no-filter set = 6 wallet + 3 Panini');
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

-- ── 8. p_query searches the WHOLE wallet, server-side (2026-11-06) ───────────
-- The cap is the trap: with p_limit=1 the name must still be found BEHIND the
-- fmv cap. m7 (Dame, fmv 10) is the cheapest wallet row; a client that searched
-- "inside the top 1" would never see it.
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL, 'lillard')), 'm7', 'p_query finds a row BEHIND the fmv cap (limit 1, Dame is the cheapest row)');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'DAME')), 'm1', 'case-insensitive player match (Dame)');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'blazers')), 'm1,m2', 'team name (editions.team_name) matches');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'rookie revelation')), 'm6', 'set name matches across collections (All Day m6)');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'mickey')), 'm5', 'character name matches (Pinnacle)');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid, 'uncat')), 'pc-2', 'Panini branch: walked athlete name matches');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'catalogued')), 'pc-1', 'Panini branch: catalogued edition player matches');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, '   ')), '9', 'blank query = no filter');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, '%')), '0', 'a literal % is a character, never a wildcard');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'D_me')), '0', 'a literal _ is a character, never a wildcard');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'nobody by this name')), '0', 'no match -> empty, never the unfiltered list');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, 'NBA', NULL, 'lillard')), 'm7', 'p_query composes with the league filter');

-- ── 9. every word must match, in ANY field (2026-11-08) ──────────────────────
-- "Damian Lillard Extra Spice" (the challenge pre-fills the name, the collector
-- appends the set) found nothing: no single field held the whole phrase.
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'Damian Lillard Cosmic')), 'm7', 'player + set words across two fields find the row');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, '  dame   blazers ')), 'm1', 'player + team words, extra whitespace ignored');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, 'lillard base')), '0', 'AND, not OR: Lillard is Cosmic and Dame is Base, so neither matches both words');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, :PAN::uuid, 'catalogued cat set')), 'pc-1', 'Panini branch: player + set words across fields');

-- ── 10. p_offset pages the same total order (2026-11-08, "Load more") ────────
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY ord) FROM (SELECT moment_id, row_number() OVER () ord FROM public.get_user_top_owned_moments(:U1::uuid, 3, NULL, NULL, NULL, 3)) x),
  'm5,m4,m6', 'second page of 3 continues the fmv order (m5 40, m4 30, m6 20)');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM (
    SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 4, NULL, NULL, NULL, 0)
    UNION ALL SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 4, NULL, NULL, NULL, 4)
    UNION ALL SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 4, NULL, NULL, NULL, 8)) x),
  (SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL)),
  'pages of 4 at offsets 0/4/8: no row repeated, none lost — the union IS the full list');
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL, NULL, 9)), '0', 'an offset past the end is empty');
SELECT _assert_eq((SELECT string_agg(moment_id, ',' ORDER BY moment_id) FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL, 'lillard', 1)), NULL, 'offset composes with p_query (1 match, page 2 is empty)');
SELECT _assert_eq((SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL, NULL, -5)), 'm1', 'a negative offset is page one, never an error');
SELECT _assert_eq((SELECT moment_id FROM public.get_user_top_owned_moments(:U1::uuid, 1, NULL, NULL, NULL, NULL)), 'm1', 'a NULL offset is page one');

SELECT '✓ get_user_top_owned_moments: all assertions passed' AS result;

ROLLBACK;
