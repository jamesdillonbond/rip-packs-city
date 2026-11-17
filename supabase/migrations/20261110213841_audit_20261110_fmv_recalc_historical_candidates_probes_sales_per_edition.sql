-- audit_20261110_fmv_recalc_historical_candidates_probes_sales_per_edition
--
-- WHY. fmv-recalc's historical fallback (app/api/fmv-recalc/route.ts step "Historical fallback") failed with
-- `canceling statement due to statement timeout` (the fn's own 60 s) on 7 of 75 runs in the 24 h to 1:45 PM PT
-- 11-10; pgss 10:05 AM -> 12:05 PM PT: 7 calls, mean 31.4 s, 32.6k blocks read per call. The `stale` half is 7 s
-- (25,255 editions: 21,326 Candy, 2,933 Panini, 996 others). The `cand` half then asked EXISTS(paid sale) per
-- survivor; with that many outer rows the planner chose a Parallel Hash Semi Join over every sales partition
-- (7.6M rows, 259k blocks read, 17.8 s on the Candy slice alone) because almost none of them HAS a sale (Candy
-- 191 of 21,517; Panini 0 -- its sales live in panini_sales), so the LIMIT never short-circuits.
--
-- WHAT. One change: EXISTS -> CROSS JOIN LATERAL (... LIMIT 1). Row-for-row the same set (an inner join to at most
-- one row per stale edition, filtered by the identical predicate), but the planner can only execute it as index
-- probes: Candy slice 2.2 s / 457k buffers hit, 2.4k read, 191 rows -- the same 191 the EXISTS form returned.
-- Whole stale+cand read under production params, warm: 2.7 s (pg_temp copy of this body returned 1 candidate).
-- Signature, return type, STABLE, SECURITY DEFINER, statement_timeout 60s, search_path and ACL unchanged.
-- Base = live body (md5 c450748b16794e8097655ce524e79487, = 20261004002116's), asserted below.
--
-- anon-exec: unchanged (fmv_recalc_historical_candidates) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the fmv_recalc_historical_candidates block of 20261004002116_audit_20261003_fmv_readers_exclude_buyback_wallets.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_recalc_historical_candidates(uuid,interval,integer)'::regprocedure)
     <> 'c450748b16794e8097655ce524e79487' THEN
    RAISE EXCEPTION 'fmv_recalc_historical_candidates live body drifted from the 20261004002116 base; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fmv_recalc_historical_candidates(p_pinnacle_collection_id uuid, p_stale_after interval DEFAULT '7 days'::interval, p_limit integer DEFAULT 200)
 RETURNS TABLE(edition_id uuid, collection_id uuid, avg_price numeric, min_price numeric, sales_count bigint, latest_sold_at timestamp with time zone, prev_confidence text, low_ask numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '60s'
 SET search_path TO 'public'
AS $function$
  WITH stale AS MATERIALIZED (
    -- The SELECTIVE half, alone. 7,224 of 26,722 survive here today.
    SELECT e.id, e.collection_id, e.external_id, la.confidence::text AS prev_confidence
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fs.edition_id, fs.confidence, fs.computed_at
      FROM fmv_snapshots fs
      WHERE fs.edition_id = e.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) la ON true
    WHERE (la.edition_id IS NULL
           OR la.confidence = 'NO_DATA'
           OR la.computed_at < now() - p_stale_after)
      AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
      AND e.collection_id <> p_pinnacle_collection_id
  ),
  cand AS (
    -- The non-selective half, now paid only for survivors -- and the LIMIT stays
    -- AFTER it, so zero-paid-sale editions can never squat the candidate set.
    -- 2026-11-10: a per-row LATERAL ... LIMIT 1 probe, not EXISTS. With ~25k stale
    -- editions (21k Candy, 2.9k Panini -- almost none with a row in `sales`) the
    -- planner turned EXISTS into a hash semi-join over ALL 7.6M sales rows
    -- (260k blocks read, 17.8 s for the Candy slice alone) and the call hit its
    -- 60 s timeout on 7 of 75 fmv-recalc runs in 24 h. The LATERAL form can only
    -- be index probes (idx_sales_*_edition_serial_sold): 2.2 s for the same
    -- slice, same 191 rows. Same rows as EXISTS: at most one per stale edition.
    SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
    FROM stale s
    CROSS JOIN LATERAL (
      SELECT 1 FROM public.sales_market sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
      LIMIT 1
    ) has_paid_sale
    LIMIT p_limit
  )
  SELECT
    c.id,
    c.collection_id,
    -- 2026-09-25: MEDIAN and MIN of the LAST 30 paid sales — the estimator
    -- drain_fmv_cold_tail writes for the same population — never the all-time
    -- mean (see the header). `avg_price` keeps its name for the route.
    -- 2026-09-25 (#140): of those 30, only the ones within 90 days of the
    -- newest sale, never fewer than the 3 most recent (same as the drain).
    h.med::numeric,
    h.mn::numeric,
    h.n,
    h.last_sold,
    c.prev_confidence,
    (SELECT MAX(be.low_ask) FROM badge_editions be
      WHERE be.external_id = c.external_id AND be.collection_id = c.collection_id
        AND be.low_ask > 0 AND be.low_ask <= 10000)
  FROM cand c
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price_usd) AS med,
           MIN(r.price_usd) AS mn,
           COUNT(*)         AS n,
           MAX(r.sold_at)   AS last_sold
    FROM (
      SELECT w.price_usd, w.sold_at
      FROM (
        SELECT l.price_usd, l.sold_at,
               row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
               max(l.sold_at) OVER () AS newest
        FROM (
          SELECT s.price_usd, s.sold_at
          FROM public.sales_market s
          WHERE s.edition_id = c.id AND s.price_usd > 0
          ORDER BY s.sold_at DESC
          LIMIT 30
        ) l
      ) w
      WHERE w.rn <= 3 OR w.sold_at >= w.newest - INTERVAL '90 days'
    ) r
  ) h
  WHERE h.n > 0;
$function$;
