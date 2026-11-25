-- audit_20261124_fmv_recalc_historical_candidates_scans_low_volume_collections
--
-- 2026-11-24 ~8:10 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously ... fix any issues you encounter").
-- WHY. fmv-recalc's :08 run still loses its historical fallback to the 60 s statement_timeout: 7 of 48 :08 runs in
-- 48 h (14.6 %; 0 at :28 / :48), the owed read from docs/handoff-2026-11-22-daytime-autonomous-pass.md item 8.
-- pgss: 9,463 calls, mean 11.8 s, ~373k buffers per call, ~1 row. EXPLAIN 11-24: 688k buffers / 21.6 s for 0 rows,
-- of which ~400k / 16 s is the per-edition paid-sale probe: 19,063 stale editions x 8 sales partitions, and 18,434
-- of them are Candy -- a collection with only 18,905 paid-sale rows (3,079 editions) in all of `sales`.
-- WHAT. New CTE `coll_scan`: per stale collection, read at most n_stale*8+1 of its paid sales. Not cut off =
-- complete set, answer from it; cut off = keep probing. Same predicate both ways, so same rows.
-- MEASURED (same session, both cold-ish): 688k -> 354k buffers, 21.6 s -> 11.0 s, 0 rows both.
-- EQUIVALENCE on a non-empty population (staleness relaxed to 1 day, 27,879 stale): old 8,582 rows, new 8,582,
-- EXCEPT both ways 0, no duplicates; Candy took the scan arm, the other four the probe arm.
-- The `stale` half (~288k buffers, the 43k latest-snapshot lookups) is unchanged.
-- Signature, return type, STABLE, SECURITY DEFINER, statement_timeout 60s, search_path and ACL unchanged.
-- Base = live body (md5 2f638605d568fa2119a1ef3cb4000f7e = 20261122042722's), asserted below.
--
-- anon-exec: unchanged (fmv_recalc_historical_candidates) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the fmv_recalc_historical_candidates block of 20261122042722_audit_20261121_fmv_recalc_historical_candidates_skips_collections_with_no_sales.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_recalc_historical_candidates(uuid,interval,integer)'::regprocedure)
     <> '2f638605d568fa2119a1ef3cb4000f7e' THEN
    RAISE EXCEPTION 'fmv_recalc_historical_candidates live body drifted from the 20261122042722 base; re-read before replacing';
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
  coll_scan AS MATERIALIZED (
    -- 2026-11-24: per stale collection, decide how to run the paid-sale test. Read at most
    -- n_stale * 8 + 1 of the collection's paid sales (8 = the sales partitions one probe walks).
    -- If that read was NOT cut off, it holds every paid sale the collection has, so `eds` is the
    -- complete set and `scanned` is true; otherwise fall back to the per-edition probe below.
    -- Exact either way: both arms test the same predicate (a sales_market row, price_usd > 0).
    -- Candy (18.4k stale editions, 18.9k paid-sale rows, 3,079 editions) takes the scan; Top Shot,
    -- All Day, Golazos and UFC keep probing. Measured 11-24: probe half 400k -> 66k buffers.
    -- ⚠ Must stay a parameterised LATERAL with its own LIMIT. An IN (SELECT ... collection_id IN
    -- ...) form seq-scanned all 7.6M sales rows (measured, 248k blocks read).
    SELECT pc.collection_id, (x.n_rows <= pc.n_stale * 8) AS scanned, x.eds
    FROM (SELECT st.collection_id, count(*) AS n_stale FROM stale st GROUP BY st.collection_id) pc
    CROSS JOIN LATERAL (
      SELECT count(*) AS n_rows, array_agg(DISTINCT q.edition_id) AS eds
      FROM (SELECT sm.edition_id FROM public.sales_market sm
             WHERE sm.collection_id = pc.collection_id AND sm.price_usd > 0
             LIMIT pc.n_stale * 8 + 1) q
    ) x
  ),
  cand AS (
    -- The non-selective half, paid only for survivors -- and the LIMIT stays AFTER it, so
    -- zero-paid-sale editions can never squat the candidate set. At most one row per stale edition.
    -- 2026-11-10: per-row LATERAL ... LIMIT 1 probes, not EXISTS (EXISTS became a hash semi-join over
    -- all 7.6M sales rows). 2026-11-24: a collection whose paid sales are few next to its stale
    -- editions is answered from coll_scan's complete set instead of 8 probes per edition.
    SELECT u.id, u.collection_id, u.external_id, u.prev_confidence
    FROM (
      SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
      FROM stale s
      JOIN coll_scan cs ON cs.collection_id = s.collection_id AND cs.scanned
      WHERE s.id = ANY (cs.eds)
      UNION ALL
      SELECT s.id, s.collection_id, s.external_id, s.prev_confidence
      FROM stale s
      JOIN coll_scan cs ON cs.collection_id = s.collection_id AND NOT cs.scanned
      CROSS JOIN LATERAL (
        SELECT 1 FROM public.sales_market sa WHERE sa.edition_id = s.id AND sa.price_usd > 0
        LIMIT 1
      ) has_paid_sale
    ) u
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
