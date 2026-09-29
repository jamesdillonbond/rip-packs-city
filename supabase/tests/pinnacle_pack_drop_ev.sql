-- DB invariant: Disney Pinnacle pack EV at DROP grain —
-- public.v_pinnacle_pack_drop_ev, public.analytics_packs_summary and
-- public.analytics_packs_top_ev. Added 2026-09-28 (#157).
--
-- A Pinnacle "Standard" pack is one $4.99 product whose supply Studio splits
-- into sub-distributions ("Summer Splash - Standard - LE Standard / LE Chasers /
-- Quartis / Xenith / Quinova / Apex"). A buyer cannot choose a pool, so a
-- pool's own EV (a 5-pack Quinova pool read 811x) is not a pack's EV.
--
-- Claims:
--   1. Pools sharing a "<drop> Standard - <pool>" prefix and a price are one
--      drop; its EV is the pack-count-weighted mean of the pools' EVs, carried
--      on every member row with the pool's share of the drop's packs.
--   2. "+EV" requires the SALES-BACKED part (value not resting on asks) to beat
--      the price; an EV mostly from asks is low-confidence and never +EV.
--   3. A distribution without siblings is its own pack (unchanged EV).
--   4. analytics_packs_summary reports Pinnacle once per drop, never from the
--      per-pool pack_ev_history rows; its average ratio excludes ask-driven
--      packs.
--   5. analytics_packs_top_ev lists a Pinnacle drop once, never a sub-pool,
--      and never an ask-driven drop.
--
-- The view and function DDL below are VERBATIM from the committed migration
-- (supabase/migrations/20260929025310_audit_20260928_pinnacle_pack_ev_at_drop_grain.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.pack_distributions (
  dist_id text, collection_id uuid, title text, metadata jsonb,
  total_minted int, total_sealed int, updated_at timestamptz DEFAULT now()
);
-- Stands in for the corrected per-pool view (its own logic is not under test).
CREATE TABLE public.v_pinnacle_pack_ev_corrected (dist_id text, corrected_gross_ev numeric, ask_value_share_pct numeric, low_confidence_ev boolean);
CREATE TABLE public.pack_ev_history (
  collection_id uuid, pack_listing_id text, pack_name text, pack_price numeric, pack_ev numeric,
  value_ratio numeric, is_positive_ev boolean, fmv_coverage_pct smallint, edition_count smallint,
  total_unopened int, depletion_pct smallint, snapshotted_at timestamptz DEFAULT now()
);

CREATE OR REPLACE VIEW public.v_pinnacle_pack_drop_ev WITH (security_invoker = on) AS
WITH dist AS (
  SELECT d.dist_id,
         d.title,
         COALESCE((d.metadata ->> 'retail_price_usd')::numeric, 0) AS pack_price,
         GREATEST(COALESCE(d.total_minted, 0), 0) AS pool_packs,
         GREATEST(COALESCE(d.total_sealed, 0), 0) AS pool_available,
         d.updated_at,
         (regexp_match(d.title, '^(.*Standard) - (.+)$'))[1] AS split_prefix,
         (regexp_match(d.title, '^(.*Standard) - (.+)$'))[2] AS pool_name
  FROM pack_distributions d
  WHERE d.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
    AND d.title IS NOT NULL
    AND d.title !~ '^\[OLD\]'
),
keyed AS (
  SELECT dist.*,
         count(*) OVER (PARTITION BY dist.split_prefix, dist.pack_price) AS siblings
  FROM dist
),
member AS (
  SELECT k.dist_id,
         k.title,
         k.pack_price,
         k.pool_packs,
         k.pool_available,
         k.updated_at,
         CASE WHEN k.split_prefix IS NOT NULL AND k.siblings >= 2 THEN k.pool_name END AS pool_name,
         CASE WHEN k.split_prefix IS NOT NULL AND k.siblings >= 2 THEN k.split_prefix END AS drop_title,
         CASE WHEN k.split_prefix IS NOT NULL AND k.siblings >= 2
              THEN 'drop:' || k.split_prefix || '|' || k.pack_price::text
              ELSE 'dist:' || k.dist_id END AS drop_key,
         c.corrected_gross_ev AS pool_gross_ev,
         c.ask_value_share_pct AS pool_ask_value_share_pct,
         c.low_confidence_ev AS pool_low_confidence_ev
  FROM keyed k
  LEFT JOIN v_pinnacle_pack_ev_corrected c ON c.dist_id = k.dist_id
),
drops AS (
  SELECT m.drop_key,
         count(*) AS drop_pools,
         sum(m.pool_packs) AS drop_packs,
         sum(m.pool_available) AS drop_available,
         max(m.updated_at) AS drop_updated_at,
         sum(m.pool_packs) FILTER (WHERE m.pool_gross_ev IS NOT NULL) AS priced_packs,
         sum(m.pool_packs * m.pool_gross_ev) FILTER (WHERE m.pool_gross_ev IS NOT NULL) AS ev_mass,
         sum(m.pool_packs * m.pool_gross_ev * COALESCE(m.pool_ask_value_share_pct, 0) / 100.0)
           FILTER (WHERE m.pool_gross_ev IS NOT NULL) AS ask_mass,
         bool_or(m.pool_low_confidence_ev) AS any_pool_low_confidence
  FROM member m
  GROUP BY m.drop_key
),
calc AS (
  SELECT m.*,
         d.drop_pools,
         d.drop_packs,
         d.drop_available,
         d.drop_updated_at,
         CASE WHEN d.drop_packs > 0 THEN round(100.0 * m.pool_packs / d.drop_packs, 2) END AS pool_share_pct,
         CASE WHEN d.drop_packs > 0 THEN round(100.0 * COALESCE(d.priced_packs, 0) / d.drop_packs, 1) END AS ev_coverage_pct,
         d.ev_mass / NULLIF(d.priced_packs, 0) AS gross_ev_raw,
         (d.ev_mass - d.ask_mass) / NULLIF(d.priced_packs, 0) AS sales_backed_ev_raw,
         round(100.0 * d.ask_mass / NULLIF(d.ev_mass, 0), 1) AS ask_value_share_pct,
         d.any_pool_low_confidence
  FROM member m
  JOIN drops d ON d.drop_key = m.drop_key
)
SELECT calc.dist_id,
       calc.drop_key,
       calc.drop_title,
       calc.pool_name,
       calc.drop_pools,
       calc.drop_packs,
       calc.drop_available,
       calc.drop_updated_at,
       calc.pool_packs,
       calc.pool_share_pct,
       calc.pool_gross_ev,
       calc.pack_price,
       calc.ev_coverage_pct,
       round(calc.gross_ev_raw, 2) AS gross_ev,
       round(calc.gross_ev_raw - calc.pack_price, 2) AS net_ev,
       CASE WHEN calc.pack_price > 0 THEN round(calc.gross_ev_raw / calc.pack_price, 3) END AS value_ratio,
       round(calc.sales_backed_ev_raw, 2) AS sales_backed_ev,
       calc.ask_value_share_pct,
       (calc.pack_price > 0
        AND calc.ev_coverage_pct >= 90
        AND calc.sales_backed_ev_raw > calc.pack_price) AS is_positive_ev,
       (COALESCE(calc.ask_value_share_pct, 0) >= 50
        OR COALESCE(calc.ev_coverage_pct, 0) < 90
        OR COALESCE(calc.drop_packs, 0) < 25
        OR (calc.drop_title IS NULL AND COALESCE(calc.any_pool_low_confidence, false))) AS low_confidence_ev,
       CASE WHEN calc.drop_title IS NOT NULL THEN 'drop_pool_weighted' ELSE 'supply_group_median' END AS ev_method
FROM calc
WHERE calc.gross_ev_raw IS NOT NULL;

CREATE OR REPLACE FUNCTION public.analytics_packs_summary(p_collections text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result jsonb;
BEGIN
  WITH latest AS (
    -- Latest snapshot per pack via the (pack_listing_id, snapshotted_at DESC)
    -- index; replaces the full-table ROW_NUMBER window sort.
    SELECT DISTINCT ON (pe.pack_listing_id)
      pe.collection_id,
      pe.pack_listing_id,
      pe.pack_price,
      pe.pack_ev,
      pe.value_ratio,
      pe.is_positive_ev,
      pe.fmv_coverage_pct,
      pe.total_unopened,
      pe.depletion_pct,
      pe.snapshotted_at
    FROM pack_ev_history pe
    ORDER BY pe.pack_listing_id, pe.snapshotted_at DESC
  ),
  named AS (
    SELECT
      CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        ELSE c.slug
      END AS coll,
      l.*
    FROM latest l
    JOIN collections c ON c.id = l.collection_id
    -- 2026-09-28: Pinnacle's pack_ev_history rows are per SUB-DISTRIBUTION of
    -- a drop (a $4.99 Standard pack draws from up to six pools), so they are
    -- not a buyer's EV. Pinnacle is answered by the drop-grain arm below.
    WHERE c.slug <> 'disney_pinnacle'
  ),
  per_collection AS (
    SELECT
      coll,
      jsonb_build_object(
        'packs_tracked',      COUNT(*),
        'sellable_packs',     COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'positive_ev_packs',  COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND is_positive_ev),
        'avg_value_ratio',    COALESCE(ROUND(AVG(value_ratio)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND value_ratio IS NOT NULL)::numeric, 2), 0),
        'median_pack_price',  COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pack_price)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000)::numeric, 2), 0),
        'total_unopened',     COALESCE(SUM(total_unopened) FILTER (WHERE pack_price BETWEEN 1 AND 5000), 0),
        'last_refresh',       MAX(snapshotted_at),
        'minutes_since_refresh', EXTRACT(EPOCH FROM (now() - MAX(snapshotted_at)))::int / 60
      ) AS stats
    FROM named
    WHERE (p_collections IS NULL OR coll = ANY(p_collections))
    GROUP BY coll
  ),
  -- 2026-09-28: Disney Pinnacle at DROP grain (v_pinnacle_pack_drop_ev): one
  -- row per purchasable pack. "+EV" = the SALES-BACKED part of the EV beats
  -- the price (value resting on asking prices is excluded); the average ratio
  -- is over packs whose EV is not mostly asks, so an ask-priced chase pool
  -- cannot set it. `low_confidence_packs` counts the rest.
  pinnacle_drops AS (
    SELECT DISTINCT ON (v.drop_key)
      v.drop_key, v.pack_price, v.value_ratio, v.is_positive_ev, v.low_confidence_ev,
      v.drop_available, v.drop_updated_at
    FROM v_pinnacle_pack_drop_ev v
    ORDER BY v.drop_key
  ),
  pinnacle AS (
    SELECT
      'pinnacle'::text AS coll,
      jsonb_build_object(
        'packs_tracked',      COUNT(*),
        'sellable_packs',     COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'positive_ev_packs',  COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND is_positive_ev),
        'low_confidence_packs', COUNT(*) FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND low_confidence_ev),
        'avg_value_ratio',    ROUND(AVG(value_ratio)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000 AND value_ratio IS NOT NULL AND NOT low_confidence_ev)::numeric, 2),
        'median_pack_price',  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY pack_price)
                                FILTER (WHERE pack_price BETWEEN 1 AND 5000)::numeric, 2),
        'total_unopened',     SUM(drop_available) FILTER (WHERE pack_price BETWEEN 1 AND 5000),
        'last_refresh',       MAX(drop_updated_at),
        'minutes_since_refresh', EXTRACT(EPOCH FROM (now() - MAX(drop_updated_at)))::int / 60,
        'ev_grain',           'drop'
      ) AS stats
    FROM pinnacle_drops
    WHERE (p_collections IS NULL OR 'pinnacle' = ANY(p_collections))
    HAVING COUNT(*) > 0
  )
  SELECT jsonb_build_object(
    'collections', COALESCE(jsonb_object_agg(coll, stats), '{}'::jsonb),
    'as_of', now(),
    'note', 'Sellable packs are those priced between $1 and $5,000. Reward/airdrop packs ($0) and holder/locked packs ($99,999) are excluded from the headline metrics.'
  )
  INTO result
  FROM (SELECT coll, stats FROM per_collection UNION ALL SELECT coll, stats FROM pinnacle) m;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.analytics_packs_top_ev(p_collections text[] DEFAULT NULL::text[], p_min_price numeric DEFAULT 1, p_max_price numeric DEFAULT 5000, p_min_unopened integer DEFAULT 1, p_min_coverage integer DEFAULT 50, p_direction text DEFAULT 'pumping'::text, p_limit integer DEFAULT 25)
 RETURNS TABLE(rank integer, collection text, pack_listing_id text, pack_name text, pack_price numeric, pack_ev numeric, value_ratio numeric, fmv_coverage_pct smallint, edition_count smallint, total_unopened integer, depletion_pct smallint, snapshotted_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH normalized AS (
    SELECT
      (CASE c.slug
        WHEN 'nba_top_shot'   THEN 'topshot'
        WHEN 'nfl_all_day'    THEN 'allday'
        WHEN 'laliga_golazos' THEN 'golazos'
        ELSE c.slug
      END)::text                AS x_coll,
      pe.pack_listing_id::text  AS x_plid,
      pe.pack_name::text        AS x_pname,
      pe.pack_price             AS x_price,
      pe.pack_ev                AS x_ev,
      pe.value_ratio            AS x_ratio,
      pe.fmv_coverage_pct       AS x_cov,
      pe.edition_count          AS x_ec,
      pe.total_unopened         AS x_unopened,
      pe.depletion_pct          AS x_depl,
      pe.snapshotted_at         AS x_snap,
      ROW_NUMBER() OVER (PARTITION BY pe.pack_listing_id ORDER BY pe.snapshotted_at DESC) AS rn
    FROM pack_ev_history pe
    JOIN collections c ON c.id = pe.collection_id
    -- 2026-09-28: Pinnacle's rows are per sub-distribution (the 811x
    -- "Quinova" pool led this list); it is answered by the drop arm below.
    WHERE c.slug <> 'disney_pinnacle'
  ),
  -- 2026-09-28: Disney Pinnacle at DROP grain — one row per purchasable pack,
  -- and only packs whose EV is not mostly asking prices (low_confidence_ev
  -- false): a leaderboard of "best packs" must not be led by ask-priced pools.
  pinnacle AS (
    SELECT DISTINCT ON (v.drop_key)
      'pinnacle'::text                          AS x_coll,
      v.drop_key                                AS x_plid,
      COALESCE(v.drop_title, d.title)::text     AS x_pname,
      v.pack_price                              AS x_price,
      v.net_ev                                  AS x_ev,
      v.value_ratio                             AS x_ratio,
      LEAST(v.ev_coverage_pct, 100)::smallint   AS x_cov,
      NULL::smallint                            AS x_ec,
      LEAST(v.drop_available, 2147483647)::int  AS x_unopened,
      NULL::smallint                            AS x_depl,
      v.drop_updated_at                         AS x_snap,
      1::bigint                                 AS rn
    FROM v_pinnacle_pack_drop_ev v
    JOIN pack_distributions d ON d.dist_id = v.dist_id
                             AND d.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
    WHERE NOT v.low_confidence_ev
    ORDER BY v.drop_key
  ),
  filtered AS (
    SELECT * FROM (SELECT * FROM normalized UNION ALL SELECT * FROM pinnacle) n
    WHERE n.rn = 1
      AND (p_collections IS NULL OR n.x_coll = ANY(p_collections))
      AND n.x_price BETWEEN p_min_price AND p_max_price
      AND n.x_unopened >= p_min_unopened
      AND n.x_cov >= p_min_coverage
      AND n.x_ratio IS NOT NULL
  )
  SELECT
    ROW_NUMBER() OVER (
      ORDER BY
        CASE WHEN p_direction = 'pumping' THEN f.x_ratio END DESC,
        CASE WHEN p_direction = 'dumping' THEN f.x_ratio END ASC,
        CASE WHEN p_direction = 'fresh'   THEN f.x_snap  END DESC
    )::int          AS rank,
    f.x_coll        AS collection,
    f.x_plid        AS pack_listing_id,
    f.x_pname       AS pack_name,
    f.x_price       AS pack_price,
    f.x_ev          AS pack_ev,
    f.x_ratio       AS value_ratio,
    f.x_cov         AS fmv_coverage_pct,
    f.x_ec          AS edition_count,
    f.x_unopened    AS total_unopened,
    f.x_depl        AS depletion_pct,
    f.x_snap        AS snapshotted_at
  FROM filtered f
  ORDER BY rank
  LIMIT p_limit;
END;
$function$;

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
INSERT INTO public.collections VALUES (:PIN::uuid, 'disney_pinnacle'), (:TS::uuid, 'nba_top_shot');

-- Drop A: "Splash - Standard", $4.99, 100 packs: 90 standard ($10, 30% asks),
-- 9 chasers ($40, 0% asks), 1 chase pool ($2,000, 100% asks).
INSERT INTO public.pack_distributions (dist_id, collection_id, title, metadata, total_minted, total_sealed) VALUES
  ('a1', :PIN::uuid, 'Splash - Standard - LE Standard', '{"retail_price_usd": 4.99}', 90, 80),
  ('a2', :PIN::uuid, 'Splash - Standard - LE Chasers',  '{"retail_price_usd": 4.99}',  9,  9),
  ('a3', :PIN::uuid, 'Splash - Standard - Quinova',     '{"retail_price_usd": 4.99}',  1,  1),
  -- Drop B: ask-driven — 100% of its value rests on asks.
  ('b1', :PIN::uuid, 'Dusk - Standard - LE Standard',   '{"retail_price_usd": 4.99}', 60, 60),
  ('b2', :PIN::uuid, 'Dusk - Standard - LE Chasers',    '{"retail_price_usd": 4.99}', 40, 40),
  -- A single distribution: its own pack.
  ('s1', :PIN::uuid, 'Treasures Vol.1 [1/1]',           '{"retail_price_usd": 49.95}', 1500, 0),
  -- A retired placeholder is never grouped or priced.
  ('o1', :PIN::uuid, '[OLD] Splash - Standard - LE Standard', '{"retail_price_usd": 4.99}', 0, 0);
INSERT INTO public.v_pinnacle_pack_ev_corrected VALUES
  ('a1', 10, 30, true),
  ('a2', 40, 0, false),
  ('a3', 2000, 100, true),
  ('b1', 20, 100, true),
  ('b2', 30, 100, true),
  ('s1', 99.90, 0, false);
-- The per-pool history the old functions read: the 811x-style row.
INSERT INTO public.pack_ev_history (collection_id, pack_listing_id, pack_name, pack_price, pack_ev, value_ratio, is_positive_ev, fmv_coverage_pct, edition_count, total_unopened) VALUES
  (:PIN::uuid, 'plid-a3', 'Splash - Standard - Quinova', 4.99, 1995.01, 400.8, true, 100, 4, 1),
  (:TS::uuid,  'plid-ts', 'Base Set', 9.99, 5, 1.5, true, 100, 20, 50);

-- Claim 1: (90*10 + 9*40 + 1*2000) / 100 = 32.60, on every member.
SELECT _assert_eq((SELECT string_agg(DISTINCT gross_ev::text, ',') FROM public.v_pinnacle_pack_drop_ev WHERE drop_title = 'Splash - Standard'), '32.60', 'drop EV is the pack-weighted mean of its pools');
SELECT _assert_eq((SELECT pool_share_pct::text || '/' || pool_gross_ev::text FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 'a3'), '1.00/2000', 'the chase pool keeps its own EV and its 1% share');
SELECT _assert_eq((SELECT drop_pools::text FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 'a1'), '3', 'the retired [OLD] pool is not a member');
-- Claim 2: asks = 90*10*0.3 + 2000 = 2270 of 3260 → 69.6%; sales-backed (3260-2270)/100 = 9.90 > 4.99.
SELECT _assert_eq((SELECT sales_backed_ev::text || '/' || ask_value_share_pct::text FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 'a1'), '9.90/69.6', 'sales-backed EV excludes ask-driven value');
SELECT _assert((SELECT is_positive_ev AND low_confidence_ev FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 'a1'), '+EV on its sales-backed part, flagged low-confidence (asks ≥ 50%)');
SELECT _assert((SELECT NOT is_positive_ev AND low_confidence_ev FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 'b1'), 'an EV resting entirely on asks is never +EV');
-- Claim 3
SELECT _assert_eq((SELECT gross_ev::text || '/' || coalesce(drop_title, 'single') || '/' || ev_method FROM public.v_pinnacle_pack_drop_ev WHERE dist_id = 's1'), '99.90/single/supply_group_median', 'a lone distribution is its own pack');

-- Claim 4: three packs (Splash, Dusk, Treasures), not six pools; no disney_pinnacle key.
SELECT _assert_eq((public.analytics_packs_summary(ARRAY['pinnacle'])->'collections'->'pinnacle'->>'packs_tracked'), '3', 'Pinnacle counted once per drop');
SELECT _assert_eq((public.analytics_packs_summary(NULL)->'collections' ? 'disney_pinnacle')::text, 'false', 'the per-pool history is not reported');
SELECT _assert_eq((public.analytics_packs_summary(ARRAY['pinnacle'])->'collections'->'pinnacle'->>'positive_ev_packs'), '2', 'Splash (sales-backed) and Treasures are +EV; Dusk is not');
SELECT _assert_eq((public.analytics_packs_summary(ARRAY['pinnacle'])->'collections'->'pinnacle'->>'avg_value_ratio'), '2.00', 'the average ratio is over non-ask-driven packs only (Treasures 99.90/49.95)');
SELECT _assert_eq((public.analytics_packs_summary(ARRAY['topshot'])->'collections'->'topshot'->>'packs_tracked'), '1', 'CONTROL: Top Shot unchanged');

-- Claim 5: no sub-pool, no ask-driven drop; the single pack is listed.
SELECT _assert_eq((SELECT count(*)::text FROM public.analytics_packs_top_ev(ARRAY['pinnacle'], 0, 5000, 0, 0, 'pumping', 25) WHERE pack_name ILIKE '%Quinova%'), '0', 'no sub-pool row');
SELECT _assert_eq((SELECT string_agg(pack_name, ',' ORDER BY rank) FROM public.analytics_packs_top_ev(ARRAY['pinnacle'], 0, 5000, 0, 0, 'pumping', 25)), 'Treasures Vol.1 [1/1]', 'ask-driven drops are left out of the leaderboard');
SELECT _assert_eq((SELECT count(*)::text FROM public.analytics_packs_top_ev(ARRAY['topshot'], 1, 5000, 1, 50, 'pumping', 25)), '1', 'CONTROL: Top Shot unchanged');

SELECT '✓ pinnacle pack drop EV: all assertions passed' AS result;

ROLLBACK;
