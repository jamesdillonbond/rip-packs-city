-- analytics_sales_timeseries v2 - the FILTERED branch becomes an Index ONLY
-- Scan, which is what Top Shot needed (2026-09-20 ~9:50 AM PT, Claude Code cloud).
--
-- WHY A SECOND MIGRATION THE SAME HOUR, stated plainly: v1
-- (20260920163600) fixed the two structural defects - partition pruning and the
-- CASE-expression filter - and that was enough for Candy, verified live
-- (500 -> 200, 31 real buckets). It was NOT enough for Top Shot, which still
-- returned 500 on a SEVEN-day window. v1 shipped a real improvement and a
-- partial one; this finishes it rather than leaving the biggest collection
-- broken.
--
-- THE REMAINING COST, measured rather than assumed. v1's read selects
-- `s.collection` (the text label) alongside collection_id and sold_at.
-- `idx_sales_<yr>_collid_soldat_cover` is (collection_id, sold_at DESC) INCLUDE
-- (marketplace, price_usd) - it carries everything the aggregate needs EXCEPT
-- that text column, so asking for it downgrades an Index Only Scan into a plain
-- Index Scan with ONE HEAP FETCH PER ROW. At Top Shot's 15,079 sales in 7 days
-- that is the whole difference.
--
-- THE FIX: group by collection_id and apply the id -> label map AFTER the
-- aggregate, where it runs once per output row (single digits) instead of once
-- per sale. Same output, different access path.
--
-- A/B, same window, same rows, warm-vs-warm (Top Shot, 7 d, 15,079 sales):
--   v1 shape (selects s.collection) : statement timeout at 50 s, Index Scan,
--                                     heap fetch per row
--   v2 shape (groups by id)         : 18.5 ms / 2,379 buffers,
--                                     "Index Only Scan using
--                                     idx_sales_2026_collid_soldat_cover",
--                                     Heap Fetches 2,372 of 15,079 rows
-- ⚠ Cold the same v2 read was 8.3 s with only 320 disk reads - that is the
-- estate's IO spell (at the time of writing refresh_mv_pack_ev_latest had been
-- running 7m57s and nearly every backend was waiting on IO/DataFileRead), not
-- this query. Buffers are the comparison that survives it.
--
-- EQUIVALENCE, proven by output and not by argument: the v2 statement was run
-- standalone against candy_mlb / 30 d and compared row by row with what the LIVE
-- v1 endpoint had just returned. All 31 buckets identical, including the cents
-- (2026-08-21 66 / $639.26 / $9.69 ... 2026-09-20 91 / $135.13 / $1.48).
--
-- ⚠ THE TWO BRANCHES ARE DELIBERATELY ASYMMETRIC, and this is the one thing not
-- to "tidy up" later. `sales.collection_id` is NULLABLE (attnotnull = false);
-- `sales.collection` is NOT NULL. So the UNFILTERED branch must NOT group by
-- collection_id - doing so would silently drop every row whose id is null and
-- publish the remainder as the whole, which is the partial-read-as-fact shape.
-- It groups by the NOT NULL text column instead, which
-- idx_sales_<yr>_pulse_window (collection, sold_at DESC) INCLUDE (price_usd, ...)
-- covers index-only anyway. Each branch uses the covering index that matches its
-- own predicate; neither can lose a row.
--
-- ⛔ STILL NOT CLAIMED: `window=all` remains unbounded work (everything from the
-- 2025 floor forward) and can still exceed the gateway cap cold. A rollup is the
-- answer and is not in this migration.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.analytics_sales_timeseries is already service_role-only and stays that way - VERIFIED with has_function_privilege (not acl text): anon EXECUTE false, authenticated EXECUTE false, service_role EXECUTE true. Reached only through /api/analytics/sales/timeseries, a service-role route.
--
-- REVERT: re-apply v1, md5 eaf20530090286c323bf84dff10a45e0 (3,146 chars), from
-- migration 20260920163600. Reverting restores Top Shot's 500.

DO $gate$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'analytics_sales_timeseries')
     IS DISTINCT FROM 'eaf20530090286c323bf84dff10a45e0'
  THEN
    RAISE EXCEPTION 'analytics_sales_timeseries body is not the v1 this migration builds on (expected md5 eaf20530090286c323bf84dff10a45e0) - re-read the live object and redraft';
  END IF;
END
$gate$;

CREATE OR REPLACE FUNCTION public.analytics_sales_timeseries(p_start_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_collections text[] DEFAULT NULL::text[], p_bucket text DEFAULT 'auto'::text)
 RETURNS TABLE(bucket date, collection text, sale_count bigint, volume_usd numeric, avg_price_usd numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  effective_bucket text;
  range_days int;
  v_trunc text;
  v_lo timestamptz;
  v_hi timestamptz;
  v_plo timestamptz;
  v_ids uuid[];
  v_pin boolean;
  v_sql text;
  v_pin_pred text := '';
  c_floor constant timestamptz := '2025-01-01 00:00:00+00';
BEGIN
  IF p_bucket = 'auto' THEN
    range_days := COALESCE(EXTRACT(EPOCH FROM (
      COALESCE(p_end_at, now()) - COALESCE(p_start_at, '2000-01-01'::timestamptz)
    ))::int / 86400, 365);
    effective_bucket := CASE WHEN range_days > 90 THEN 'week' ELSE 'day' END;
  ELSE
    effective_bucket := p_bucket;
  END IF;

  -- Collapse to exactly two literals before it can reach the SQL text. p_bucket
  -- is caller-supplied, so this is the injection boundary as well as the choice.
  v_trunc := CASE WHEN effective_bucket = 'week' THEN 'week' ELSE 'day' END;

  v_pin := (p_collections IS NULL OR 'pinnacle' = ANY(p_collections));
  IF NOT v_pin THEN
    v_pin_pred := ' AND false ';
  END IF;

  v_hi  := COALESCE(p_end_at, 'infinity'::timestamptz);
  v_plo := COALESCE(p_start_at, '-infinity'::timestamptz);
  v_lo  := GREATEST(v_plo, c_floor);

  IF p_collections IS NOT NULL THEN
    SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_ids
    FROM collections c
    WHERE c.slug IN (
      SELECT CASE q
               WHEN 'topshot'        THEN 'nba_top_shot'
               WHEN 'allday'         THEN 'nfl_all_day'
               WHEN 'golazos'        THEN 'laliga_golazos'
               WHEN 'ufc'            THEN 'ufc_strike'
               WHEN 'nba_top_shot'   THEN NULL
               WHEN 'nfl_all_day'    THEN NULL
               WHEN 'laliga_golazos' THEN NULL
               WHEN 'ufc_strike'     THEN NULL
               ELSE q
             END
      FROM unnest(p_collections) AS q
    );

    -- FILTERED BRANCH: group by collection_id so the read is served ENTIRELY by
    -- idx_sales_<yr>_collid_soldat_cover (collection_id, sold_at) INCLUDE
    -- (marketplace, price_usd) as an Index ONLY Scan. Selecting s.collection
    -- here instead would force one heap fetch per row and is exactly what made
    -- Top Shot time out. The id -> label map is applied AFTER the aggregate, so
    -- it runs once per output row (single digits), not once per sale.
    v_sql := format($q$
      SELECT g.b,
             (CASE c.slug
                WHEN 'nba_top_shot'   THEN 'topshot'
                WHEN 'nfl_all_day'    THEN 'allday'
                WHEN 'laliga_golazos' THEN 'golazos'
                WHEN 'ufc_strike'     THEN 'ufc'
                ELSE c.slug
              END)::text AS coll,
             g.n, g.vol, g.avgp
      FROM (
        SELECT date_trunc(%2$L, s.sold_at)::date AS b,
               s.collection_id                   AS cid,
               COUNT(*)::bigint                  AS n,
               COALESCE(ROUND(SUM(s.price_usd)::numeric, 2), 0) AS vol,
               COALESCE(ROUND(AVG(s.price_usd)::numeric, 2), 0) AS avgp
        FROM sales s
        WHERE s.sold_at >= $1 AND s.sold_at < $2
          AND s.collection_id = ANY($4)
        GROUP BY 1, 2
      ) g
      JOIN collections c ON c.id = g.cid
      UNION ALL
      SELECT date_trunc(%2$L, ps.sold_at)::date, 'pinnacle'::text,
             COUNT(*)::bigint,
             COALESCE(ROUND(SUM(ps.sale_price_usd)::numeric, 2), 0),
             COALESCE(ROUND(AVG(ps.sale_price_usd)::numeric, 2), 0)
      FROM pinnacle_sales ps
      WHERE ps.sold_at >= $3 AND ps.sold_at < $2 %1$s
      GROUP BY 1, 2
      ORDER BY 1, 2
    $q$, v_pin_pred, v_trunc);

    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, v_ids;
  ELSE
    -- UNFILTERED BRANCH: no collection_id predicate, so group by the TEXT
    -- column, which idx_sales_<yr>_pulse_window (collection, sold_at DESC)
    -- INCLUDE (price_usd, ...) covers index-only.
    --
    -- ⚠ AND THIS IS DELIBERATE, NOT SYMMETRY MISSED. sales.collection_id is
    -- NULLABLE; sales.collection is NOT NULL. Scoping an UNFILTERED read by
    -- collection_id would silently drop every row whose id is null and report
    -- the remainder as the whole - the partial-read-as-fact shape. Grouping by
    -- the NOT NULL column cannot lose a row.
    v_sql := format($q$
      SELECT date_trunc(%2$L, s.sold_at)::date AS b,
             (CASE s.collection
                WHEN 'nba_top_shot'   THEN 'topshot'
                WHEN 'nfl_all_day'    THEN 'allday'
                WHEN 'laliga_golazos' THEN 'golazos'
                WHEN 'ufc_strike'     THEN 'ufc'
                ELSE s.collection
              END)::text AS coll,
             COUNT(*)::bigint,
             COALESCE(ROUND(SUM(s.price_usd)::numeric, 2), 0),
             COALESCE(ROUND(AVG(s.price_usd)::numeric, 2), 0)
      FROM sales s
      WHERE s.sold_at >= $1 AND s.sold_at < $2
      GROUP BY 1, 2
      UNION ALL
      SELECT date_trunc(%2$L, ps.sold_at)::date, 'pinnacle'::text,
             COUNT(*)::bigint,
             COALESCE(ROUND(SUM(ps.sale_price_usd)::numeric, 2), 0),
             COALESCE(ROUND(AVG(ps.sale_price_usd)::numeric, 2), 0)
      FROM pinnacle_sales ps
      WHERE ps.sold_at >= $3 AND ps.sold_at < $2 %1$s
      GROUP BY 1, 2
      ORDER BY 1, 2
    $q$, v_pin_pred, v_trunc);

    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo;
  END IF;
END;
$function$;
