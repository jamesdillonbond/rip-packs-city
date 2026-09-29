-- audit_20260928_pinnacle_pack_ev_at_drop_grain  (#157)
--
-- A Disney Pinnacle "Standard" pack is ONE $4.99 product whose supply Studio
-- splits into sub-distributions, e.g. Summer Splash - Standard: LE Standard
-- 2,115 packs, LE Chasers 321, Quartis 23, Xenith 10, Quinova 5, Apex 1 (read
-- from Studio's searchDistributions 2026-09-28; the "Standard - <pool>" titles
-- share price and start time). A buyer cannot choose a pool. RPC priced each
-- pool as a pack, so the 5-pack Quinova pool read EV $4,050 / 811x, and it led
-- the site-wide "top EV" list, with 8 more sub-pools behind it; the Packs
-- dashboard counted 39 of 91 such rows "+EV".
--
-- New view v_pinnacle_pack_drop_ev: one EV per purchasable pack.
--   * Drop = pools whose title is "<X Standard> - <pool>" with the same price
--     (4 drops today: Summer Splash / Showcase / Adventure, D23 2026). Every
--     other distribution is its own pack.
--   * Drop EV = Σ(pool packs × pool EV) / Σ(pool packs) over priced pools, pool
--     EV from v_pinnacle_pack_ev_corrected. Weighted by TOTAL supply, the
--     designed pool: Studio's availableSupply reads 300/300 unsold on a
--     month-old Premium drop, so it is not a reliable current pool.
--   * sales_backed_ev = the part of the EV not resting on ASK_ONLY prices
--     (the pools' ask_value_share_pct). "+EV" requires THAT to beat the price,
--     with ≥90% of the drop's packs priced. low_confidence_ev when asks carry
--     ≥50% of the EV, coverage < 90%, or the drop has < 25 packs.
--   Live: Summer Splash - Standard EV $36.07 (sales-backed $6.22, 83% asks);
--   Summer Adventure - Standard $47.69 but sales-backed $0.24 (99.5% asks) →
--   not +EV.
-- analytics_packs_summary / analytics_packs_top_ev: Pinnacle comes from the
-- view at drop grain ('pinnacle' key; per-pool pack_ev_history rows no longer
-- reported under 'disney_pinnacle'). The summary's average ratio and the
-- top-EV leaderboard exclude low-confidence (ask-driven) packs.
--
-- The live bodies of both functions (md5 7877e2a414556b0895826d245c0e0da3,
-- ec087714715cf1f566e819f67e2b55ef) were in no committed migration; this file
-- now defines them. Only the Pinnacle handling changes.
--
-- anon-exec: revoked (analytics_packs_summary) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to service_role (the analytics routes' caller).
-- anon-exec: revoked (analytics_packs_top_ev) — REVOKEd from PUBLIC, anon, authenticated below and re-GRANTed to service_role (the analytics routes' caller).
--
-- Pin: supabase/tests/pinnacle_pack_drop_ev.sql (DDL verbatim).
-- Revert: DROP VIEW v_pinnacle_pack_drop_ev (after re-applying the two
-- functions without their Pinnacle arms and without the disney_pinnacle
-- exclusion); /api/packs falls back to v_pinnacle_pack_ev_corrected.

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

REVOKE ALL ON public.v_pinnacle_pack_drop_ev FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_pinnacle_pack_drop_ev TO service_role;

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

REVOKE EXECUTE ON FUNCTION public.analytics_packs_summary(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_packs_summary(text[]) TO service_role;
REVOKE EXECUTE ON FUNCTION public.analytics_packs_top_ev(text[], numeric, numeric, integer, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_packs_top_ev(text[], numeric, numeric, integer, integer, text, integer) TO service_role;

-- Post-flight: no Pinnacle sub-pool leads the leaderboard, the four split
-- drops each carry one EV, and the summary reports Pinnacle at drop grain.
DO $verify$
DECLARE v_n int; v_s jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.analytics_packs_top_ev(NULL, 1, 5000, 0, 0, 'pumping', 100)
   WHERE collection IN ('pinnacle', 'disney_pinnacle') AND pack_name ~ 'Standard - ';
  IF v_n > 0 THEN RAISE EXCEPTION 'a Pinnacle sub-pool is still on the leaderboard (% rows)', v_n; END IF;
  SELECT count(*) INTO v_n FROM (
    SELECT drop_key FROM public.v_pinnacle_pack_drop_ev WHERE drop_title IS NOT NULL
    GROUP BY drop_key HAVING count(DISTINCT gross_ev) <> 1) x;
  IF v_n > 0 THEN RAISE EXCEPTION '% drops carry more than one EV', v_n; END IF;
  v_s := public.analytics_packs_summary(NULL)->'collections';
  IF v_s ? 'disney_pinnacle' OR NOT v_s ? 'pinnacle' THEN RAISE EXCEPTION 'summary keys wrong: %', v_s; END IF;
  RAISE NOTICE 'pinnacle summary: %', v_s->'pinnacle';
END
$verify$;
