-- DB invariant: public.refresh_seeded_wallet_stats — writes the seeded_wallets
-- display cache (moment count, total FMV, top tier) read by leaderboards and the
-- watch-wallet surfaces. Two things must stay correct: the count/FMV come from the
-- authoritative holdings_summary (not a second, drifting computation), and the
-- top-tier is chosen by RARITY RANK, not by row count — a bug there would label a
-- whale by their most-common tier.
--
-- Pins:
--   * cached_moment_count / cached_fmv_usd read holdings_summary's total_moments /
--     total_fmv_usd, defaulting to 0 when absent (never NULL/garbage);
--   * cached_top_tier follows the ladder ultimate>legendary>rare>fandom>common
--     (a single legendary beats three rares), with count as the tiebreak, and
--     NULL/'' tiers ignored;
--   * exactly the addressed seeded_wallets row is updated, stamping last_refreshed_at.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729000000_audit_20260729_snapshot_read_write_rpc_ddl_for_pinning.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.wallet_moments_cache (wallet_address text, tier text);
CREATE TABLE public.seeded_wallets (
  wallet_address text PRIMARY KEY, cached_moment_count int, cached_fmv_usd numeric,
  cached_top_tier text, last_refreshed_at timestamptz);

-- Stub the authoritative summary (real one aggregates FMV across collections).
CREATE TABLE public._hs (wallet text, summary jsonb);
CREATE FUNCTION public.holdings_summary(p_wallet text)
 RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT summary FROM public._hs WHERE wallet = p_wallet), '{}'::jsonb)
$$;

-- >>> BEGIN verbatim refresh_seeded_wallet_stats (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_seeded_wallet_stats(p_wallet_address text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_summary  jsonb;
  v_count    integer;
  v_fmv      numeric;
  v_top_tier text;
BEGIN
  -- Authoritative FMV + moment count via dashboard function
  v_summary := holdings_summary(p_wallet_address);
  v_count   := COALESCE((v_summary->>'total_moments')::integer, 0);
  v_fmv     := COALESCE((v_summary->>'total_fmv_usd')::numeric, 0);

  -- Top tier still derived from wmc (holdings_summary doesn't surface it)
  SELECT tier INTO v_top_tier
  FROM wallet_moments_cache
  WHERE wallet_address = p_wallet_address
    AND tier IS NOT NULL
    AND tier <> ''
  GROUP BY tier
  ORDER BY
    CASE lower(tier)
      WHEN 'ultimate'  THEN 5
      WHEN 'legendary' THEN 4
      WHEN 'rare'      THEN 3
      WHEN 'fandom'    THEN 2
      WHEN 'common'    THEN 1
      ELSE 0
    END DESC,
    count(*) DESC
  LIMIT 1;

  UPDATE seeded_wallets
  SET
    cached_moment_count = v_count,
    cached_fmv_usd      = v_fmv,
    cached_top_tier     = v_top_tier,
    last_refreshed_at   = now()
  WHERE wallet_address = p_wallet_address;
END;
$function$;
-- <<< END verbatim refresh_seeded_wallet_stats <<<

-- Wallet W: 3 rare, 1 legendary, 2 common, 1 '' , 1 NULL -> top = legendary (rank beats count).
INSERT INTO public.wallet_moments_cache (wallet_address, tier) VALUES
  ('W','rare'),('W','rare'),('W','rare'),
  ('W','legendary'),
  ('W','common'),('W','common'),
  ('W',''),('W',NULL);
-- Wallet W3: empty summary -> defaults; tiers only common.
INSERT INTO public.wallet_moments_cache (wallet_address, tier) VALUES ('W3','common');

INSERT INTO public._hs (wallet, summary) VALUES
  ('W', '{"total_moments":7,"total_fmv_usd":1234.5}'::jsonb);
-- W3 has no _hs row -> holdings_summary returns '{}' -> count/fmv default to 0.

INSERT INTO public.seeded_wallets (wallet_address, cached_moment_count, cached_fmv_usd, cached_top_tier, last_refreshed_at) VALUES
  ('W',  -1, -1, 'stale', now() - interval '10 days'),
  ('W3', -1, -1, 'stale', now() - interval '10 days');

SELECT public.refresh_seeded_wallet_stats('W');
SELECT public.refresh_seeded_wallet_stats('W3');

-- ── 1. count/FMV from holdings_summary ───────────────────────────────────────
SELECT _assert_eq((SELECT cached_moment_count::text FROM seeded_wallets WHERE wallet_address='W'), '7', 'cached_moment_count from holdings_summary');
SELECT _assert_eq((SELECT cached_fmv_usd::text FROM seeded_wallets WHERE wallet_address='W'), '1234.5', 'cached_fmv_usd from holdings_summary');

-- ── 2. top-tier by rank, not count (legendary over 3 rares) ──────────────────
SELECT _assert_eq((SELECT cached_top_tier FROM seeded_wallets WHERE wallet_address='W'), 'legendary', 'top tier = legendary (rank beats the 3-rare count)');

-- ── 3. defaults to 0 on empty summary ────────────────────────────────────────
SELECT _assert_eq((SELECT cached_moment_count::text FROM seeded_wallets WHERE wallet_address='W3'), '0', 'empty summary -> count 0');
SELECT _assert_eq((SELECT cached_fmv_usd::text FROM seeded_wallets WHERE wallet_address='W3'), '0', 'empty summary -> fmv 0');
SELECT _assert_eq((SELECT cached_top_tier FROM seeded_wallets WHERE wallet_address='W3'), 'common', 'W3 top tier = common');

-- ── 4. last_refreshed_at stamped fresh ───────────────────────────────────────
SELECT _assert((SELECT last_refreshed_at FROM seeded_wallets WHERE wallet_address='W') >= now() - interval '1 minute', 'last_refreshed_at stamped now');

SELECT '✓ refresh_seeded_wallet_stats: all assertions passed' AS result;

ROLLBACK;
