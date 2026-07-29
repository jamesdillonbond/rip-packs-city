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
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260726016000_audit_20260726_serial_fmv_consumers_pooled_edition_id.sql);
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
  )
  SELECT
    r.moment_id, r.collection_id, c.slug::TEXT, r.wallet_address,
    r.player_name, r.set_name, r.tier, r.serial_number, r.mint_count,
    r.fmv_usd,
    COALESCE(
      r.image_url,
      e.thumbnail_url,
      NULLIF(pe.thumbnail_url, 'https://assets.disneypinnacle.com/on-chain/pinnacle.jpg'),
      CASE
        WHEN c.slug = 'nba_top_shot' THEN
          'https://assets.nbatopshot.com/media/' || r.moment_id || '/image?width=512'
        ELSE NULL
      END
    ) AS image_url,
    r.is_locked, r.series_number, r.edition_key, r.character_name,
    r.edition_name, r.league,
    public.serial_fmv_estimate(r.collection_id, r.serial_number, r.mint_count, r.tier, sf.fmv_usd, sf.confidence::text, e.id) AS serial_fmv,
    e.team_name,
    e.jersey_number::integer
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
  ORDER BY r.fmv_usd DESC NULLS LAST
  LIMIT p_limit;
END;
$function$;
-- <<< END verbatim get_user_top_owned_moments <<<

\set U1 '''10000000-0000-0000-0000-000000000001'''
\set U2 '''20000000-0000-0000-0000-000000000002'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set eK1 '''aaaaaaaa-0000-0000-0000-0000000000k1'''

INSERT INTO public.collections (id, slug) VALUES (:TS::uuid, 'nba_top_shot'), (:PIN::uuid, 'disney_pinnacle');
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
SELECT _assert_eq((SELECT count(*)::text FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL)), '4', 'no-filter set = 4 (m3 fmv=0 dropped, m1 deduped)');
-- top row is m1, and it is the HIGHER-fmv (wA) copy
SELECT _assert_eq((SELECT wallet_address FROM public.get_user_top_owned_moments(:U1::uuid, 24, NULL, NULL) ORDER BY fmv_usd DESC LIMIT 1), 'wA', 'dedupe keeps the higher-fmv (wA) copy of m1');

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

SELECT '✓ get_user_top_owned_moments: all assertions passed' AS result;

ROLLBACK;
