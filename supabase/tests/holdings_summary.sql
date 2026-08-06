-- DB invariant: public.holdings_summary — the wallet total-FMV + composition
-- aggregate. It feeds refresh_seeded_wallet_stats (the seeded_wallets cache), the
-- dashboard, and /share, so its FMV resolution and concentration math are
-- load-bearing. The single subtlest rule: Pinnacle FMV comes from wmc.fmv_usd
-- (denormalized per-render), NOT from fmv_snapshots — the standard uuid-keyed
-- snapshot path would return nothing for Pinnacle and zero out a real balance.
--
-- Pins:
--   * wallet is lowercased/trimmed; username resolves from seeded_wallets or
--     wallet_usernames;
--   * FMV per moment: disney_pinnacle -> wmc.fmv_usd; every other collection ->
--     the LATEST non-null fmv_snapshots_2026 for the held edition;
--   * total_moments / total_fmv_usd / collections_held aggregate across held
--     collections; per-collection sum_fmv rounded;
--   * top_collection + top_collection_pct + concentration_label thresholds
--     (>=95 mono / >=75 light dabbler / >=50 primary+secondary / else diversified);
--   * diversity_score = 1 - HHI (sum of squared moment-count shares);
--   * an empty wallet -> zeros / '[]' (never an error).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729000200_audit_20260729_snapshot_holdings_summary_ddl.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.seeded_wallets (wallet_address text, username text);
CREATE TABLE public.wallet_usernames (wallet_addr text, username text);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text, market_closed_at timestamptz);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, edition_key text, tier text, fmv_usd numeric);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, collection_id uuid, tier text);
CREATE TABLE public.fmv_snapshots_2026 (edition_id uuid, fmv_usd numeric, computed_at timestamptz);

-- >>> BEGIN verbatim holdings_summary (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.holdings_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_username text;
  v_collections jsonb;
  v_total_moments int := 0;
  v_total_fmv_usd numeric := 0;
  v_collections_held int := 0;
  v_top_collection text;
  v_concentration_pct numeric;
  v_concentration_label text;
  v_diversity_score numeric;
  v_sum_squared_shares numeric := 0;
BEGIN
  SELECT COALESCE(sw.username, wu.username) INTO v_username
  FROM (SELECT 1) dummy
  LEFT JOIN seeded_wallets sw ON LOWER(sw.wallet_address) = v_wallet
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = v_wallet
  LIMIT 1;

  WITH
  resolved AS (
    SELECT
      c.slug,
      c.id AS collection_id,
      c.market_closed_at,
      COALESCE(e.tier::text, wmc.tier) AS resolved_tier,
      CASE
        -- June 6 (Wave 2): Pinnacle reads wmc.fmv_usd -- the per-render FMV
        -- denormalized hourly from pinnacle_catalog (Wave 1a).
        WHEN c.slug = 'disney_pinnacle' THEN wmc.fmv_usd
        ELSE uf.fmv_usd
      END AS resolved_fmv_usd,
      wmc.edition_key
    FROM wallet_moments_cache wmc
    JOIN collections c ON c.id = wmc.collection_id
    LEFT JOIN editions e ON e.external_id = wmc.edition_key
      AND e.collection_id = wmc.collection_id
      AND c.slug != 'disney_pinnacle'
    -- Correlated latest-non-null FMV for ONLY the editions this wallet holds.
    -- Replaces a DISTINCT ON over all 914,600 fmv_snapshots_2026 rows.
    -- No computed_at age filter, deliberately (May 7 fix).
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd
      FROM fmv_snapshots_2026 fs
      WHERE fs.edition_id = e.id
        AND fs.fmv_usd IS NOT NULL
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) uf ON true
    WHERE wmc.wallet_address = v_wallet
  ),
  per_coll_basics AS (
    SELECT
      slug,
      collection_id,
      MIN(market_closed_at) AS market_closed_at,
      COUNT(*) AS moment_count,
      COUNT(*) FILTER (WHERE edition_key IS NOT NULL) AS with_edition_key,
      COUNT(*) FILTER (WHERE resolved_fmv_usd IS NOT NULL) AS with_fmv,
      COUNT(*) FILTER (WHERE resolved_tier IS NOT NULL) AS with_tier,
      COALESCE(SUM(resolved_fmv_usd), 0) AS sum_fmv_usd
    FROM resolved GROUP BY slug, collection_id
  ),
  per_coll_tiers AS (
    SELECT
      slug,
      collection_id,
      jsonb_object_agg(resolved_tier, cnt) AS tier_breakdown
    FROM (
      SELECT slug, collection_id, resolved_tier, COUNT(*) AS cnt
      FROM resolved
      WHERE resolved_tier IS NOT NULL
      GROUP BY slug, collection_id, resolved_tier
    ) sub
    GROUP BY slug, collection_id
  ),
  joined AS (
    SELECT pcb.*, pct.tier_breakdown
    FROM per_coll_basics pcb
    LEFT JOIN per_coll_tiers pct USING (slug, collection_id)
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'slug', slug,
      'moment_count', moment_count,
      'metadata_coverage_pct', ROUND(100.0 * with_edition_key / NULLIF(moment_count, 0), 1),
      'fmv_coverage_pct', ROUND(100.0 * with_fmv / NULLIF(moment_count, 0), 1),
      'tier_coverage_pct', ROUND(100.0 * with_tier / NULLIF(moment_count, 0), 1),
      'sum_fmv_usd', ROUND(sum_fmv_usd, 2),
      'market_closed_at', market_closed_at,
      'tier_breakdown', COALESCE(tier_breakdown, '{}'::jsonb),
      'render_status', CASE
        WHEN moment_count = 0 THEN 'empty'
        WHEN with_edition_key::numeric / NULLIF(moment_count, 0) >= 0.95 THEN 'full'
        WHEN with_edition_key::numeric / NULLIF(moment_count, 0) >= 0.5 THEN 'partial'
        ELSE 'metadata_pending'
      END
    ) ORDER BY moment_count DESC),
    SUM(moment_count),
    -- Grand FMV excludes closed markets (dead-market value is not a portfolio
    -- total). Per-collection sum_fmv_usd is retained above for reference/UI, but
    -- the wallet-level cached total this feeds (seeded_wallets.cached_fmv_usd)
    -- must not include a closed collection.
    SUM(sum_fmv_usd) FILTER (WHERE market_closed_at IS NULL),
    COUNT(*)
  INTO v_collections, v_total_moments, v_total_fmv_usd, v_collections_held
  FROM joined
  WHERE moment_count > 0;

  IF v_total_moments > 0 THEN
    SELECT slug, ROUND(100.0 * moment_count / v_total_moments, 1)
    INTO v_top_collection, v_concentration_pct
    FROM (
      SELECT slug, moment_count
      FROM jsonb_to_recordset(v_collections) AS r(slug text, moment_count int)
      ORDER BY moment_count DESC LIMIT 1
    ) top;

    SELECT SUM(POWER(moment_count::numeric / v_total_moments, 2))
    INTO v_sum_squared_shares
    FROM jsonb_to_recordset(v_collections) AS r(moment_count int);

    v_diversity_score := ROUND(1 - v_sum_squared_shares, 3);

    v_concentration_label := CASE
      WHEN v_concentration_pct >= 95 THEN 'mono-collection'
      WHEN v_concentration_pct >= 75 THEN 'primary + light dabbler'
      WHEN v_concentration_pct >= 50 THEN 'primary + secondary'
      ELSE 'genuinely diversified'
    END;
  END IF;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'username', v_username,
    'total_moments', COALESCE(v_total_moments, 0),
    'total_fmv_usd', ROUND(COALESCE(v_total_fmv_usd, 0), 2),
    'collections_held', COALESCE(v_collections_held, 0),
    'top_collection', v_top_collection,
    'top_collection_pct', v_concentration_pct,
    'concentration_label', v_concentration_label,
    'diversity_score', v_diversity_score,
    'collections', COALESCE(v_collections, '[]'::jsonb)
  );
END;
$function$;
-- <<< END verbatim holdings_summary <<<

\set TS  '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

INSERT INTO public.collections (id, slug) VALUES (:TS::uuid, 'nba_top_shot'), (:PIN::uuid, 'disney_pinnacle');
INSERT INTO public.seeded_wallets (wallet_address, username) VALUES ('0xWALLET', 'whale');

-- wallet 'w' holds 3 TS moments (k1=100 latest, k2=50, k3=no snapshot) + 1 Pinnacle
-- moment whose FMV must come from wmc.fmv_usd (30), NOT fmv_snapshots.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, tier, fmv_usd) VALUES
  ('0xwallet', :TS::uuid,  'k1', NULL,     NULL),   -- tier resolves from editions
  ('0xwallet', :TS::uuid,  'k2', NULL,     NULL),
  ('0xwallet', :TS::uuid,  'k3', 'COMMON', NULL),   -- no snapshot -> fmv null
  ('0xwallet', :PIN::uuid, 'kp', 'CHASER', 30);     -- Pinnacle fmv from wmc

INSERT INTO public.editions (id, external_id, collection_id, tier) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, 'k1', :TS::uuid, 'RARE'),
  ('e2222222-2222-2222-2222-222222222222'::uuid, 'k2', :TS::uuid, 'COMMON'),
  ('e3333333-3333-3333-3333-333333333333'::uuid, 'k3', :TS::uuid, 'COMMON');

-- k1 latest snapshot 100 must win over the older 999.
INSERT INTO public.fmv_snapshots_2026 (edition_id, fmv_usd, computed_at) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, 999, now() - interval '2 days'),
  ('e1111111-1111-1111-1111-111111111111'::uuid, 100, now()),
  ('e2222222-2222-2222-2222-222222222222'::uuid, 50, now());

-- ── 1. wallet lowercased + username resolution ──────────────────────────────
SELECT _assert_eq((public.holdings_summary('  0xWALLET  ') ->> 'wallet'), '0xwallet', 'wallet lowercased + trimmed');
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'username'), 'whale', 'username from seeded_wallets (case-insensitive)');

-- ── 2. totals + Pinnacle-from-wmc FMV path ───────────────────────────────────
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'total_moments'), '4', 'total_moments = 4');
-- 100 (k1 latest) + 50 (k2) + 0 (k3 null) + 30 (Pinnacle wmc) = 180
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'total_fmv_usd'), '180.00', 'total_fmv = 180.00 (Pinnacle FMV from wmc, latest TS snapshot)');
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'collections_held'), '2', 'collections_held = 2');

-- ── 3. per-collection: Pinnacle sum_fmv from wmc, TS from snapshots ──────────
SELECT _assert_eq(
  (SELECT c ->> 'sum_fmv_usd' FROM jsonb_array_elements(public.holdings_summary('0xWALLET') -> 'collections') c WHERE c ->> 'slug' = 'disney_pinnacle'),
  '30.00', 'Pinnacle sum_fmv from wmc.fmv_usd = 30.00');
SELECT _assert_eq(
  (SELECT c ->> 'sum_fmv_usd' FROM jsonb_array_elements(public.holdings_summary('0xWALLET') -> 'collections') c WHERE c ->> 'slug' = 'nba_top_shot'),
  '150.00', 'Top Shot sum_fmv = 150.00 (latest snapshots; k3 null contributes 0)');

-- ── 4. concentration + diversity math ────────────────────────────────────────
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'top_collection'), 'nba_top_shot', 'top_collection = Top Shot (3 of 4)');
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'top_collection_pct'), '75.0', 'concentration = 75.0%');
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'concentration_label'), 'primary + light dabbler', 'label at 75% = primary + light dabbler');
-- diversity = 1 - (0.75^2 + 0.25^2) = 1 - 0.625 = 0.375
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'diversity_score'), '0.375', 'diversity_score = 1 - HHI = 0.375');

-- ── 5. empty wallet -> zeros / [] ────────────────────────────────────────────
SELECT _assert_eq((public.holdings_summary('0xnobody') ->> 'total_moments'), '0', 'empty wallet -> 0 moments');
SELECT _assert_eq((public.holdings_summary('0xnobody') ->> 'total_fmv_usd'), '0.00', 'empty wallet -> 0.00 fmv');
SELECT _assert_eq((public.holdings_summary('0xnobody') -> 'collections')::text, '[]', 'empty wallet -> [] collections');

-- ── 6. closed-market exclusion (2026-08-03): a closed collection's moments still
--      count and its per-collection sum_fmv_usd is retained, but its value is
--      excluded from the grand total_fmv_usd (which feeds seeded_wallets.cached_fmv_usd).
UPDATE public.collections SET market_closed_at = now() WHERE slug = 'disney_pinnacle';
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'total_moments'), '4', 'closed market still counts moments (total_moments stays 4)');
SELECT _assert_eq((public.holdings_summary('0xWALLET') ->> 'total_fmv_usd'), '150.00', 'closed Pinnacle FMV (30) excluded from grand total -> 150.00');
SELECT _assert_eq(
  (SELECT c ->> 'sum_fmv_usd' FROM jsonb_array_elements(public.holdings_summary('0xWALLET') -> 'collections') c WHERE c ->> 'slug' = 'disney_pinnacle'),
  '30.00', 'closed Pinnacle per-collection sum_fmv retained (30.00)');
SELECT _assert((SELECT (c ->> 'market_closed_at') IS NOT NULL FROM jsonb_array_elements(public.holdings_summary('0xWALLET') -> 'collections') c WHERE c ->> 'slug' = 'disney_pinnacle'), 'closed Pinnacle collection entry carries market_closed_at');

SELECT '✓ holdings_summary: all assertions passed' AS result;

ROLLBACK;
