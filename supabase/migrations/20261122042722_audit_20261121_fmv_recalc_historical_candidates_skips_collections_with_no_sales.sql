-- audit_20261121_fmv_recalc_historical_candidates_skips_collections_with_no_sales
--
-- 2026-11-21 ~8:20 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously ... fix anything").
-- WHY. fmv-recalc's historical fallback still hit its own 60 s statement_timeout on 14 of 255 runs in 3 days
-- (PostgREST 500s; extra.historical_fallback_error). Measured 11-21 ~8:18 PM PT: 1,178k buffers, 42k read,
-- 23.0 s for 3 rows. The stale half is cheap (0.8 s warm, 28,393 editions); the cost is the per-edition paid-sale
-- probe across 7 sales partitions, and 9,320 of those editions are Panini -- 0 rows in `sales` (its sales live in
-- panini_sales), so every one of those probes is guaranteed empty.
-- WHAT. One CTE: `sold_colls` = collections with at least one paid sale in sales_market (the probe's own
-- predicate), and the stale set is restricted to them. Row-for-row the same output: an edition in a collection
-- with no paid sale can never pass the probe. Computed per call (one index probe per collection), never a
-- hardcoded list. Same query with the filter: 690k buffers, 25.5k read, 15.5 s. Output compared against the
-- live function before applying (see the ledger entry).
-- Signature, return type, STABLE, SECURITY DEFINER, statement_timeout 60s, search_path and ACL unchanged.
-- Base = live body (md5 58e1be844716fa68f185538a61c3aa9d = 20261110213841's), asserted below.
--
-- anon-exec: unchanged (fmv_recalc_historical_candidates) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the fmv_recalc_historical_candidates block of 20261110213841_audit_20261110_fmv_recalc_historical_candidates_probes_sales_per_edition.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_recalc_historical_candidates(uuid,interval,integer)'::regprocedure)
     <> '58e1be844716fa68f185538a61c3aa9d' THEN
    RAISE EXCEPTION 'fmv_recalc_historical_candidates live body drifted from the 20261110213841 base; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fmv_recalc_historical_candidates(p_pinnacle_collection_id uuid, p_stale_after interval DEFAULT '7 days'::interval, p_limit integer DEFAULT 200)
 RETURNS TABLE(edition_id uuid, collection_id uuid, avg_price numeric, min_price numeric, sales_count bigint, latest_sold_at timestamp with time zone, prev_confidence text, low_ask numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '60s'
 SET search_path TO 'public'
AS $function$
  WITH sold_colls AS MATERIALIZED (
    -- 2026-11-21: only collections that HAVE a paid sale in sales_market can yield a candidate, so a
    -- collection with none is skipped before the per-edition probe. Exact by construction (the probe
    -- below is the same predicate) and re-derived every call, so it stays right if a collection starts
    -- selling. Panini (its sales live in panini_sales) put 9,320 of 28,393 stale editions through
    -- 7 sales partitions each for nothing: 1.18M -> 690k buffers, 23 s -> 15.5 s on 11-21.
    SELECT c.id FROM public.collections c
    WHERE EXISTS (SELECT 1 FROM public.sales_market x WHERE x.collection_id = c.id AND x.price_usd > 0)
  ),
  stale AS MATERIALIZED (
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
      AND e.collection_id IN (SELECT sc.id FROM sold_colls sc)
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
