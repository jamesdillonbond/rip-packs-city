-- DB invariant: public.get_wallet_moments_with_fmv — THE wallet-display read (the
-- collection Moments grid + FMV). A regression here is directly user-visible:
-- wrong FMV, wrong sort, or a fabricated price band on a collector's own page.
-- This pins the TopShot (edition-keyed `base_other`) path's crisp invariants:
--   (a) LATEST-FMV-per-edition — the LATERAL takes the newest fmv_snapshots row
--       with computed_at <= now() (a future-dated snapshot is ignored).
--   (b) the SORT ladder — fmv_desc / fmv_asc / serial_asc select the right key.
--   (c) FILTER + total_count — filters (player/series/tier) apply, and total_count
--       is the FILTERED count, independent of the LIMIT page.
--   (d) price_band_30d GATE — the 30-day p10/p90 band is computed ONLY for a
--       LOW/MEDIUM-confidence edition with sales_count_30d >= 10, edition_id set,
--       and >= 5 qualifying recent sales; a HIGH-confidence edition gets NULL.
--   (e) serial_fmv passthrough — the per-row estimate is surfaced (estimator
--       stubbed; its own logic is pinned in serial_fmv_estimate.sql).
--   (f) the JSON envelope {moments:[...], total_count:N}.
--
--   (g) the SERIES 0-vs-1 CONVENTION — wmc.series_number is the ON-CHAIN number
--       and editions.series is the DISPLAY number. Top Shot has NO on-chain
--       series 1 (its Series 1 is 0), so the editions FALLBACK arm normalises
--       1 -> 0 for Top Shot ONLY. Every other collection legitimately uses 1
--       (All Day / Golazos / Pinnacle; UFC has BOTH 0 and 1), so a blanket
--       remap would corrupt four collections — hence the collection-scoped CASE.
--
-- serial_fmv_estimate is stubbed (separately pinned). The function DDL below is a
-- VERBATIM copy of the committed migration
-- (supabase/migrations/20260830023744_audit_20260830_get_wallet_moments_with_fmv_plpgsql_custom_plan_sql_functions_are_param_blind.sql
-- — LANGUAGE plpgsql + plan_cache_mode=force_custom_plan since 2026-08-30; the SQL body is
-- byte-identical to the 20260806033000 version, wrapped in RETURN ( ... ));
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, moment_id text, edition_key text, render_id text,
  serial_number integer, player_name text, set_name text, tier text, series_number integer,
  mint_count integer, character_name text, image_url text, team_name text,
  acquired_at timestamptz, last_seen_at timestamptz, is_locked boolean
);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, collection_id uuid, player_name text, set_name text,
  name text, tier text, series integer, circulation_count integer, team_name text, thumbnail_url text
);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, confidence text, floor_price_usd numeric,
  algo_version text, sales_count_30d integer, computed_at timestamptz
);
CREATE TABLE public.pinnacle_catalog (
  render_id text, character_name text, set_name text, variant text, total_minted integer,
  fmv_usd numeric, fmv_confidence text, floor_ask numeric, fmv_algo_version text
);
CREATE TABLE public.moment_acquisitions (
  nft_id text, wallet text, buy_price numeric, acquisition_method text, acquisition_confidence text,
  source text, source_address text, acquired_date timestamptz, loan_principal numeric, created_at timestamptz
);
CREATE TABLE public.sales (edition_id uuid, price_usd numeric, sold_at timestamptz);

-- Stubbed serial-FMV estimator (7-arg overload the wallet fn calls). Returns a
-- marker so we can assert the wallet fn surfaces it.
CREATE FUNCTION public.serial_fmv_estimate(uuid, integer, integer, text, numeric, text, uuid)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"stub":true}'::jsonb $$;

-- TopShot collection (the fn's default) + two editions.
-- editionA: LEGENDARY, HIGH confidence, fmv 100 (latest) — price_band must be NULL.
-- editionB: RARE, LOW confidence, fmv 20, sales_count_30d 12 — price_band computed.
INSERT INTO public.editions (id, external_id, collection_id, tier, circulation_count, player_name, set_name, name) VALUES
  ('e1111111-1111-1111-1111-111111111111', 'setA:playA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LEGENDARY', 100, 'Alice Ace', 'Set A', 'Alice Ace — Set A'),
  ('e2222222-2222-2222-2222-222222222222', 'setB:playB', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'RARE', 500, 'Bob Baller', 'Set B', 'Bob Baller — Set B');

-- editionA snapshots: an OLD (50), the NEWEST valid (100), and a FUTURE one (999)
-- that must be ignored (computed_at > now()). Latest-valid → 100, HIGH, sc30d 2.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, floor_price_usd, algo_version, sales_count_30d, computed_at) VALUES
  ('e1111111-1111-1111-1111-111111111111', 50,  'HIGH', 40, '1.7.0', 2, now() - interval '10 days'),
  ('e1111111-1111-1111-1111-111111111111', 100, 'HIGH', 90, '1.7.0', 2, now() - interval '1 day'),
  ('e1111111-1111-1111-1111-111111111111', 999, 'HIGH', 900, '1.7.0', 2, now() + interval '1 day'),
  ('e2222222-2222-2222-2222-222222222222', 20,  'LOW',  18, '1.7.0', 12, now() - interval '1 day');

-- editionB: 6 qualifying sales in the last 30d (>= 5 → band computed).
INSERT INTO public.sales (edition_id, price_usd, sold_at) VALUES
  ('e2222222-2222-2222-2222-222222222222', 10, now() - interval '2 days'),
  ('e2222222-2222-2222-2222-222222222222', 12, now() - interval '3 days'),
  ('e2222222-2222-2222-2222-222222222222', 14, now() - interval '4 days'),
  ('e2222222-2222-2222-2222-222222222222', 16, now() - interval '5 days'),
  ('e2222222-2222-2222-2222-222222222222', 18, now() - interval '6 days'),
  ('e2222222-2222-2222-2222-222222222222', 20, now() - interval '7 days');

-- Wallet holds both moments (serial A=5, B=1).
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key, serial_number, last_seen_at, is_locked) VALUES
  ('0xowner', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mA', 'setA:playA', 5, now() - interval '1 day', false),
  ('0xowner', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'mB', 'setB:playB', 1, now() - interval '2 days', false);

-- ── Series 0-vs-1 convention fixtures ───────────────────────────────────────
-- editionA carries a DISPLAY series of 1 and its wmc row has a NULL
-- series_number, so the COALESCE falls through to the editions arm — the exact
-- shape of the 385,734 Top Shot rows that rendered a bare "1" and were silently
-- dropped by the "Series 1" filter (which sends the ON-CHAIN 0).
UPDATE public.editions SET series = 1 WHERE id = 'e1111111-1111-1111-1111-111111111111';
-- editionB keeps an explicit ON-CHAIN series on the wmc row, which must still win
-- over the editions fallback (2 is Series 2 on Top Shot, unaffected by the CASE).
UPDATE public.wallet_moments_cache SET series_number = 2 WHERE moment_id = 'mB';

-- An ALL DAY holding where display series 1 is LEGITIMATE (All Day really does
-- have an on-chain Series 1). This is the mutation guard against "fix" attempts
-- that drop the collection scope: an unscoped 1 -> 0 remap reds this.
INSERT INTO public.editions (id, external_id, collection_id, tier, circulation_count, player_name, set_name, name, series) VALUES
  ('e3333333-3333-3333-3333-333333333333', 'setC:playC', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'RARE', 200, 'Cam Carter', 'Set C', 'Cam Carter — Set C', 1);
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key, serial_number, last_seen_at, is_locked) VALUES
  ('0xowner', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'mC', 'setC:playC', 7, now() - interval '1 day', false);

-- >>> BEGIN verbatim get_wallet_moments_with_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_moments_with_fmv(p_wallet text, p_sort_by text DEFAULT 'fmv_desc'::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_player text DEFAULT NULL::text, p_series integer DEFAULT NULL::integer, p_tier text DEFAULT NULL::text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
BEGIN
  RETURN (
  WITH
  pin_uuid AS (SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS u),
  base_other AS (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      NULL::text AS render_id,
      wmc.serial_number,
      COALESCE(
        wmc.player_name, e.player_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 1)) ELSE e.name END
      ) AS player_name,
      COALESCE(
        wmc.set_name, e.set_name,
        CASE WHEN position(' — ' in COALESCE(e.name, '')) > 0
             THEN trim(split_part(e.name, ' — ', 2)) ELSE NULL END
      ) AS set_name,
      COALESCE(wmc.tier, e.tier::text) AS tier,
      COALESCE(
        wmc.series_number,
        CASE WHEN p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND e.series = 1
             THEN 0 ELSE e.series END
      ) AS series_number,
      e.circulation_count,
      COALESCE(wmc.team_name, e.team_name) AS team_name,
      e.thumbnail_url,
      e.name AS edition_name,
      lf.fmv_usd,
      lf.confidence,
      lf.floor_price_usd AS low_ask,
      lf.algo_version AS fmv_method,
      wmc.acquired_at AS acquired_at_raw,
      wmc.last_seen_at,
      COALESCE(wmc.is_locked, false) AS is_locked,
      e.id AS edition_id,
      lf.sales_count_30d
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = p_collection_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence::text AS confidence, fs.floor_price_usd, fs.algo_version, fs.sales_count_30d
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id AND fs.computed_at <= now()
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND p_collection_id <> (SELECT u FROM pin_uuid)
  ),
  base_pinnacle AS (
    SELECT
      wmc.moment_id,
      wmc.edition_key,
      wmc.render_id,
      wmc.serial_number,
      COALESCE(pc.character_name, wmc.character_name, wmc.player_name) AS player_name,
      COALESCE(pc.set_name, wmc.set_name) AS set_name,
      COALESCE(pc.variant, wmc.tier) AS tier,
      NULL::integer AS series_number,
      COALESCE(pc.total_minted, wmc.mint_count) AS circulation_count,
      NULL::text AS team_name,
      COALESCE(wmc.image_url,
               CASE WHEN wmc.render_id IS NOT NULL
                    THEN '/api/public/pinnacle-image/' || wmc.render_id END) AS thumbnail_url,
      (COALESCE(pc.character_name, wmc.character_name, 'Pin')
        || COALESCE(' — ' || COALESCE(pc.set_name, wmc.set_name), '')
        || COALESCE(' (' || pc.variant || ')', '')) AS edition_name,
      pc.fmv_usd,
      pc.fmv_confidence::text AS confidence,
      pc.floor_ask AS low_ask,
      pc.fmv_algo_version AS fmv_method,
      wmc.acquired_at AS acquired_at_raw,
      wmc.last_seen_at,
      false AS is_locked,
      NULL::uuid AS edition_id,
      NULL::integer AS sales_count_30d
    FROM wallet_moments_cache wmc
    LEFT JOIN pinnacle_catalog pc ON pc.render_id = wmc.render_id
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND p_collection_id = (SELECT u FROM pin_uuid)
  ),
  base AS (
    SELECT * FROM base_other UNION ALL SELECT * FROM base_pinnacle
  ),
  filtered AS (
    SELECT * FROM base
    WHERE (p_player IS NULL OR lower(player_name) LIKE '%' || lower(p_player) || '%')
      AND (p_series IS NULL OR series_number = p_series)
      AND (p_tier IS NULL OR lower(tier) = lower(p_tier))
  ),
  total AS (
    SELECT count(*) AS cnt FROM filtered
  ),
  paged AS (
    SELECT f.*
    FROM filtered f
    ORDER BY
      CASE WHEN p_sort_by IN ('fmv_desc', 'price_desc') THEN f.fmv_usd END DESC NULLS LAST,
      CASE WHEN p_sort_by IN ('fmv_asc', 'price_asc') THEN f.fmv_usd END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'serial_asc' THEN f.serial_number END ASC NULLS LAST,
      CASE WHEN p_sort_by = 'recent' THEN f.last_seen_at END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_desc' THEN (
        SELECT ma2.buy_price FROM moment_acquisitions ma2
        WHERE ma2.nft_id = f.moment_id AND ma2.wallet = p_wallet
        ORDER BY ma2.created_at DESC LIMIT 1
      ) END DESC NULLS LAST,
      CASE WHEN p_sort_by = 'paid_asc' THEN (
        SELECT ma2.buy_price FROM moment_acquisitions ma2
        WHERE ma2.nft_id = f.moment_id AND ma2.wallet = p_wallet
        ORDER BY ma2.created_at DESC LIMIT 1
      ) END ASC NULLS LAST,
      CASE WHEN p_sort_by NOT IN ('fmv_desc','price_desc','fmv_asc','price_asc','serial_asc','recent','paid_desc','paid_asc') THEN f.fmv_usd END DESC NULLS LAST,
      f.moment_id
    LIMIT p_limit OFFSET p_offset
  ),
  enriched AS (
    SELECT
      p.moment_id,
      p.edition_key,
      p.render_id,
      p.serial_number,
      p.player_name,
      p.set_name,
      p.tier,
      p.series_number,
      p.circulation_count,
      p.team_name,
      p.thumbnail_url,
      p.edition_name,
      p.fmv_usd,
      p.confidence,
      p.low_ask,
      p.fmv_method,
      COALESCE(ma.acquired_date, p.acquired_at_raw) AS acquired_at,
      p.last_seen_at,
      ma.buy_price,
      ma.acquisition_method,
      ma.acquisition_confidence,
      ma.source AS acquisition_source,
      ma.source_address,
      ma.loan_principal,
      p.is_locked,
      p.edition_id,
      p.sales_count_30d,
      public.serial_fmv_estimate(p_collection_id, p.serial_number, p.circulation_count, p.tier, p.fmv_usd, p.confidence, p.edition_id) AS serial_fmv,
      CASE
        WHEN p.confidence IN ('LOW', 'MEDIUM')
             AND COALESCE(p.sales_count_30d, 0) >= 10
             AND p.edition_id IS NOT NULL
        THEN (
          WITH raw AS (
            SELECT s.price_usd::numeric AS pr
            FROM sales s
            WHERE s.edition_id = p.edition_id
              AND s.sold_at >= now() - interval '30 days'
              AND s.price_usd IS NOT NULL
              AND s.price_usd >= 0.50
          ),
          med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY pr) AS m FROM raw),
          cleaned AS (
            SELECT r.pr FROM raw r CROSS JOIN med
            WHERE med.m IS NULL OR r.pr <= med.m * 5
          )
          SELECT CASE WHEN count(*) >= 5 THEN jsonb_build_object(
                   'low',  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY pr)::numeric, 2),
                   'high', round(percentile_cont(0.90) WITHIN GROUP (ORDER BY pr)::numeric, 2),
                   'n', count(*)
                 ) ELSE NULL END
          FROM cleaned
        )
        ELSE NULL
      END AS price_band_30d
    FROM paged p
    LEFT JOIN LATERAL (
      SELECT ma2.buy_price, ma2.acquisition_method, ma2.acquisition_confidence,
             ma2.source, ma2.source_address, ma2.acquired_date, ma2.loan_principal
      FROM moment_acquisitions ma2
      WHERE ma2.nft_id = p.moment_id AND ma2.wallet = p_wallet
      ORDER BY ma2.created_at DESC
      LIMIT 1
    ) ma ON true
  )
  SELECT json_build_object(
    'moments', COALESCE((SELECT json_agg(row_to_json(enriched)) FROM enriched), '[]'::json),
    'total_count', (SELECT cnt FROM total)
  )
  );
END;
$function$;
-- <<< END verbatim get_wallet_moments_with_fmv <<<

-- (1) JSON envelope + total_count = 2 (both held moments).
SELECT public.get_wallet_moments_with_fmv('0xowner') AS r \gset
SELECT _assert_eq((:'r'::jsonb->>'total_count'), '2', 'total_count is the filtered count');
SELECT _assert_eq(jsonb_typeof(:'r'::jsonb->'moments'), 'array', 'moments is a JSON array');

-- (2) LATEST-FMV: editionA reads 100 (newest valid), NOT 50 (old) nor 999 (future).
SELECT _assert_eq(
  (SELECT (m->>'fmv_usd') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mA'),
  '100', 'latest valid snapshot wins; a future-dated snapshot is ignored');

-- (3) SORT fmv_desc (default): A (100) before B (20).
SELECT _assert_eq(
  ((:'r'::jsonb->'moments')->0->>'moment_id'), 'mA', 'fmv_desc puts the pricier moment first');

-- (4) SORT serial_asc: B (serial 1) before A (serial 5).
SELECT public.get_wallet_moments_with_fmv('0xowner', 'serial_asc') AS rs \gset
SELECT _assert_eq(
  ((:'rs'::jsonb->'moments')->0->>'moment_id'), 'mB', 'serial_asc puts the lower serial first');

-- (5) FILTER by tier + total_count reflects the filter (RARE → only editionB).
SELECT public.get_wallet_moments_with_fmv('0xowner', 'fmv_desc', 100, 0, NULL, NULL, 'rare') AS rf \gset
SELECT _assert_eq((:'rf'::jsonb->>'total_count'), '1', 'tier filter narrows total_count');
SELECT _assert_eq(
  ((:'rf'::jsonb->'moments')->0->>'moment_id'), 'mB', 'only the RARE moment survives the filter');

-- (6) price_band_30d GATE: computed for editionB (LOW conf, sc30d 12, 6 sales → n=6);
-- NULL for editionA (HIGH confidence).
SELECT _assert_eq(
  (SELECT (m->'price_band_30d'->>'n') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mB'),
  '6', 'LOW-confidence edition with >=10 sc30d and >=5 recent sales gets a 30d band (n=6)');
SELECT _assert_eq(
  (SELECT (m->>'price_band_30d') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mA'),
  NULL, 'HIGH-confidence edition never gets a price band');

-- (7) serial_fmv passthrough: the (stubbed) estimate is surfaced per row.
SELECT _assert_eq(
  (SELECT (m->'serial_fmv'->>'stub') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mA'),
  'true', 'the per-serial FMV estimate is surfaced on each row');

-- (8) Empty wallet → an empty moments array, total_count 0 (never null/errors).
SELECT public.get_wallet_moments_with_fmv('0xnobody') AS re \gset
SELECT _assert_eq((:'re'::jsonb->'moments')::text, '[]', 'empty wallet → [] moments');
SELECT _assert_eq((:'re'::jsonb->>'total_count'), '0', 'empty wallet → total_count 0');

-- (9) SERIES CONVENTION — Top Shot: a DISPLAY series of 1 from the editions
-- fallback arm is emitted as the ON-CHAIN 0, so it both renders via the series
-- map and matches the "Series 1" filter (which sends 0).
SELECT _assert_eq(
  (SELECT (m->>'series_number') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mA'),
  '0', 'Top Shot: editions.series=1 (display) is normalised to on-chain 0');

-- an explicit wmc.series_number still WINS over the editions fallback.
SELECT _assert_eq(
  (SELECT (m->>'series_number') FROM jsonb_array_elements(:'r'::jsonb->'moments') m WHERE m->>'moment_id'='mB'),
  '2', 'an on-chain wmc.series_number is never overridden by the editions fallback');

-- the FILTER half: p_series=0 ("Series 1") must FIND mA. Before the fix this
-- returned 0 rows — a silently incomplete collection with no error.
SELECT public.get_wallet_moments_with_fmv('0xowner', 'fmv_desc', 100, 0, NULL, 0) AS r9 \gset
SELECT _assert_eq((:'r9'::jsonb->>'total_count'), '1', 'Series 1 filter (on-chain 0) finds the normalised row');
SELECT _assert_eq(
  ((:'r9'::jsonb->'moments')->0->>'moment_id'), 'mA', 'the Series 1 filter returns the right moment');
-- and Top Shot must have NOTHING at on-chain series 1 (there is no such series).
SELECT public.get_wallet_moments_with_fmv('0xowner', 'fmv_desc', 100, 0, NULL, 1) AS r9b \gset
SELECT _assert_eq((:'r9b'::jsonb->>'total_count'), '0', 'Top Shot has no on-chain series 1 after normalisation');

-- (10) SCOPE GUARD — All Day series 1 is LEGITIMATE and must NOT be rewritten.
-- An unscoped 1 -> 0 remap turns this into 0 and fails here.
SELECT public.get_wallet_moments_with_fmv('0xowner', 'fmv_desc', 100, 0, NULL, NULL, NULL, 'dee28451-5d62-409e-a1ad-a83f763ac070') AS r10 \gset
SELECT _assert_eq(
  (SELECT (m->>'series_number') FROM jsonb_array_elements(:'r10'::jsonb->'moments') m WHERE m->>'moment_id'='mC'),
  '1', 'All Day: series 1 is legitimate and survives untouched');
SELECT public.get_wallet_moments_with_fmv('0xowner', 'fmv_desc', 100, 0, NULL, 1, NULL, 'dee28451-5d62-409e-a1ad-a83f763ac070') AS r10b \gset
SELECT _assert_eq((:'r10b'::jsonb->>'total_count'), '1', 'All Day: the Series 1 filter still matches on 1');

SELECT '✓ get_wallet_moments_with_fmv invariants pass' AS result;
ROLLBACK;
