-- DB invariant: public.aggregate_saved_wallet_stats — writes the cached per-collection figures on
-- saved_wallets (cached_moment_count / cached_fmv_usd / cached_fmv_stale_usd / cached_top_tier) that
-- the dashboard Saved Wallets tiles, the single Portfolio FMV, the public profile, the share card and
-- the weekly email all read.
--
-- ⚠ PINNED 2026-11-26 BECAUSE ITS FIRST CHANGE IN MONTHS BROKE IT FOR EVERY WALLET. 20261126194428
-- added a UNION ALL branch for UFC Strike Moments on linked Aptos accounts and put editions.tier
-- (tier_type) beside wallet_moments_cache.tier (text): every call raised 42804 for ~3 minutes until
-- 20261126194735 cast it. The reconcile pin could not see it — it STUBS this function. This file runs
-- the REAL body over tables with the REAL column types (tier_type and fmv_confidence enums), so a
-- union / type / column mistake fails here first.
--
-- Pins:
--   * auth.uid() set and <> p_user_id raises 42501; anon (NULL uid, the service sweep) passes;
--   * Flow holdings (wallet_moments_cache) per collection: count, FMV sum, stale share (STALE
--     confidence, or a withdrawn current price on a cached FMV), top tier by the tier ladder;
--   * UFC Strike Moments on Aptos accounts linked to the Flow address are ADDED to the UFC group,
--     valued at edition_fmv_current (2026-11-26) — and a wallet holding UFC ONLY on Aptos gets a
--     UFC figure at all;
--   * a zero sum is NULL (never $0); rows of another user / wallet are untouched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261126194735_audit_20261126_saved_wallet_stats_ufc_aptos_tier_cast.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('test.auth_uid', true), '')::uuid
$$;

CREATE TYPE tier_type AS ENUM ('COMMON','FANDOM','RARE','LEGENDARY','ULTIMATE','UNCOMMON','CHAMPION','CHALLENGER','CONTENDER');
CREATE TYPE fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','ASK_ONLY','SALES_ONLY','STALE','NO_DATA');

CREATE TABLE public.saved_wallets (
  user_id uuid, wallet_addr text, collection_id uuid,
  cached_moment_count integer, cached_fmv_usd numeric, cached_fmv_stale_usd numeric,
  cached_stale_count integer, cached_top_tier text, cache_updated_at timestamptz);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, tier tier_type);
CREATE TABLE public.edition_fmv_current (edition_id uuid PRIMARY KEY, fmv_usd numeric, confidence fmv_confidence);
CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, edition_key text, fmv_usd numeric, tier text);
CREATE TABLE public.ufc_aptos_wallet_links (flow_address text, aptos_address text, confidence text);
CREATE TABLE public.ufc_aptos_holdings (token_data_id text, aptos_address text, edition_id uuid, serial_number integer,
                                        last_tx_at timestamptz, refreshed_at timestamptz);
-- Production body (20261116), reproduced so the union reads what production reads.
CREATE FUNCTION public.get_ufc_aptos_holdings_for_flow(p_flow_address text)
 RETURNS TABLE(aptos_address text, link_confidence text, token_data_id text, edition_id uuid, serial_number integer, last_tx_at timestamp with time zone, refreshed_at timestamp with time zone)
 LANGUAGE sql STABLE AS $$
  SELECT h.aptos_address, l.confidence, h.token_data_id, h.edition_id, h.serial_number, h.last_tx_at, h.refreshed_at
    FROM ufc_aptos_wallet_links l
    JOIN ufc_aptos_holdings h ON h.aptos_address = l.aptos_address
   WHERE l.flow_address = lower(p_flow_address)
   ORDER BY h.edition_id, h.serial_number
$$;

CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH items AS (
    SELECT wmc.collection_id, wmc.fmv_usd, wmc.tier, efc.confidence,
           efc.edition_id AS efc_edition_id, efc.fmv_usd AS efc_fmv_usd
      FROM public.wallet_moments_cache wmc
      LEFT JOIN public.editions e
        ON e.external_id = wmc.edition_key
       AND e.collection_id = wmc.collection_id
      LEFT JOIN public.edition_fmv_current efc
        ON efc.edition_id = e.id
     WHERE wmc.wallet_address = p_wallet_addr
    UNION ALL
    -- 2026-11-26: UFC Strike Moments on Aptos accounts linked to this Flow address, valued
    -- at the edition's current FMV exactly as the binder's value tile values them.
    SELECT e.collection_id, efc.fmv_usd, e.tier::text, efc.confidence,
           efc.edition_id, efc.fmv_usd
      FROM public.get_ufc_aptos_holdings_for_flow(p_wallet_addr) h
      JOIN public.editions e ON e.id = h.edition_id
      LEFT JOIN public.edition_fmv_current efc ON efc.edition_id = h.edition_id
  ),
  agg AS (
    SELECT
      i.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(i.fmv_usd), 0) AS fmv_sum,
      -- Stale split (2026-09-02): latest confidence per edition from edition_fmv_current.
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      COALESCE(SUM(i.fmv_usd) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)), 0) AS fmv_stale_sum,
      COUNT(*) FILTER (WHERE i.confidence = 'STALE' OR (i.efc_edition_id IS NOT NULL AND i.efc_fmv_usd IS NULL AND i.fmv_usd IS NOT NULL)) AS stale_count,
      (array_agg(UPPER(i.tier) ORDER BY
        CASE UPPER(i.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(i.tier))
       FILTER (WHERE i.tier IS NOT NULL))[1] AS top_tier
    FROM items i
    GROUP BY i.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count  = agg.moment_count,
    cached_fmv_usd       = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_fmv_stale_usd = CASE WHEN agg.fmv_stale_sum > 0 THEN agg.fmv_stale_sum ELSE NULL END,
    cached_stale_count   = agg.stale_count,
    cached_top_tier      = agg.top_tier,
    cache_updated_at     = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

-- ── fixtures ─────────────────────────────────────────────────────────────────
-- TS = a Flow collection; UFC = UFC Strike.
INSERT INTO public.editions VALUES
  ('e0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','ts-1','LEGENDARY'),
  ('e0000000-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','ts-2','COMMON'),
  ('e0000000-0000-0000-0000-000000000003','9b4824a8-736d-4a96-b450-8dcc0c46b023','ufc-1','FANDOM'),
  ('e0000000-0000-0000-0000-000000000004','9b4824a8-736d-4a96-b450-8dcc0c46b023','ufc-2','CHALLENGER');
INSERT INTO public.edition_fmv_current VALUES
  ('e0000000-0000-0000-0000-000000000001', 100, 'HIGH'),
  ('e0000000-0000-0000-0000-000000000002', NULL, 'NO_DATA'),     -- withdrawn current price
  ('e0000000-0000-0000-0000-000000000003', 2, 'STALE'),
  ('e0000000-0000-0000-0000-000000000004', 5, 'MEDIUM');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xflow','aaaaaaaa-0000-0000-0000-000000000001','ts-1', 100, 'LEGENDARY'),
  ('0xflow','aaaaaaaa-0000-0000-0000-000000000001','ts-2', 3,   'COMMON'),   -- cached FMV over a withdrawn price -> stale
  ('0xflow','9b4824a8-736d-4a96-b450-8dcc0c46b023','ufc-1', 2,  'FANDOM');
INSERT INTO public.ufc_aptos_wallet_links VALUES ('0xflow','0xapt','high'), ('0xonlyapt','0xapt2','high');
INSERT INTO public.ufc_aptos_holdings VALUES
  ('0xt1','0xapt','e0000000-0000-0000-0000-000000000004', 7, now(), now()),
  ('0xt2','0xapt','e0000000-0000-0000-0000-000000000003', 8, now(), now()),
  ('0xt3','0xapt2','e0000000-0000-0000-0000-000000000004', 9, now(), now());
INSERT INTO public.saved_wallets (user_id, wallet_addr, collection_id) VALUES
  ('11111111-1111-1111-1111-111111111111','0xflow','aaaaaaaa-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111','0xflow','9b4824a8-736d-4a96-b450-8dcc0c46b023'),
  ('22222222-2222-2222-2222-222222222222','0xonlyapt','9b4824a8-736d-4a96-b450-8dcc0c46b023'),
  ('33333333-3333-3333-3333-333333333333','0xflow','aaaaaaaa-0000-0000-0000-000000000001');  -- another user, same wallet

-- ── authz ────────────────────────────────────────────────────────────────────
SET LOCAL test.auth_uid = '22222222-2222-2222-2222-222222222222';
DO $$ BEGIN
  PERFORM public.aggregate_saved_wallet_stats('11111111-1111-1111-1111-111111111111', '0xflow');
  RAISE EXCEPTION 'expected forbidden_cross_user';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
SET LOCAL test.auth_uid = '';

-- ── the real body runs (this is the 42804 regression) ───────────────────────
SELECT _assert_eq(public.aggregate_saved_wallet_stats('11111111-1111-1111-1111-111111111111', '0xflow')::text, '2',
  'the aggregate RUNS over the real column types and updates both of the wallet''s collections');

-- Flow collection: 2 Moments, $103, $3 stale (cached FMV over a withdrawn current price), top LEGENDARY.
SELECT _assert_eq((SELECT cached_moment_count::text || '|' || cached_fmv_usd::text || '|' || cached_fmv_stale_usd::text || '|' || cached_stale_count::text || '|' || cached_top_tier
                     FROM public.saved_wallets WHERE user_id='11111111-1111-1111-1111-111111111111' AND collection_id='aaaaaaaa-0000-0000-0000-000000000001'),
  '2|103|3|1|LEGENDARY', 'Flow figures: count, sum, stale share and top tier');

-- UFC: 1 on Flow ($2 STALE) + 2 on Aptos ($5 MEDIUM + $2 STALE) = 3 Moments, $9, $4 stale.
SELECT _assert_eq((SELECT cached_moment_count::text || '|' || cached_fmv_usd::text || '|' || cached_fmv_stale_usd::text || '|' || cached_stale_count::text
                     FROM public.saved_wallets WHERE user_id='11111111-1111-1111-1111-111111111111' AND collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023'),
  '3|9|4|2', 'UFC adds the Moments on linked Aptos accounts, valued at edition_fmv_current, with the same stale split');

SELECT _assert((SELECT cached_moment_count FROM public.saved_wallets WHERE user_id='33333333-3333-3333-3333-333333333333') IS NULL,
  'another user''s row for the same wallet is untouched');

-- A wallet holding UFC ONLY on Aptos (no wallet_moments_cache rows at all) still gets its UFC figure.
SELECT _assert_eq(public.aggregate_saved_wallet_stats('22222222-2222-2222-2222-222222222222', '0xonlyapt')::text, '1',
  'an Aptos-only UFC wallet is aggregated');
SELECT _assert_eq((SELECT cached_moment_count::text || '|' || cached_fmv_usd::text
                     FROM public.saved_wallets WHERE user_id='22222222-2222-2222-2222-222222222222'),
  '1|5', 'its UFC row counts the Aptos Moment at its current FMV');

-- A zero sum is NULL, never $0.
UPDATE public.edition_fmv_current SET fmv_usd = NULL;
UPDATE public.wallet_moments_cache SET fmv_usd = NULL;
SELECT public.aggregate_saved_wallet_stats('11111111-1111-1111-1111-111111111111', '0xflow');
SELECT _assert((SELECT cached_fmv_usd FROM public.saved_wallets WHERE user_id='11111111-1111-1111-1111-111111111111' AND collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023') IS NULL,
  'nothing priced -> cached_fmv_usd NULL, not 0');

SELECT '✓ aggregate_saved_wallet_stats invariants pass' AS result;
ROLLBACK;
