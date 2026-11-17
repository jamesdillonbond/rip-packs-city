-- /analytics/sales' volume chart is 500ing in production for EVERY collection
-- (2026-09-20 ~9:35 AM PT, Claude Code cloud).
--
-- MEASURED LIVE BEFORE TOUCHING ANYTHING, via the production caller:
--   /api/analytics/sales/timeseries?collections=candy_mlb&window=l30  -> 500
--   /api/analytics/sales/timeseries?collections=topshot&window=l30    -> 500
--   /api/analytics/sales/timeseries?window=l30                        -> 500
-- So this is NOT a Candy gap. The chart has been dead for all six collections,
-- and the 500 is a statement timeout, not a logic error.
--
-- CAUSE, read off the PLAN rather than guessed. Two independent defects, either
-- of which alone is fatal:
--
--  1. NO PARTITION PRUNING. The predicates were written
--     `(p_start_at IS NULL OR s.sold_at >= p_start_at)`. An OR against a
--     non-constant is not prunable and not indexable, so it lands in `Filter:`
--     and NEVER in `Index Cond:`. Plan for a THIRTY-DAY window:
--       -> Parallel Seq Scan on sales_2025
--       -> Parallel Seq Scan on sales_2027
--       -> Parallel Index Only Scan on sales_2026
--            Index Cond: (sold_at >= '2025-01-01')   <- the VIEW's own floor,
--                                                       i.e. the whole partition
--     Every partition from 2025 on, in full, to answer "the last 30 days".
--
--  2. THE COLLECTION FILTER CANNOT USE AN INDEX. `analytics_sales` is a view
--     whose `collection` column is `CASE s.collection WHEN 'nba_top_shot' THEN
--     'topshot' ... ELSE s.collection END`, so filtering the view's output
--     filters a CASE EXPRESSION. The plan shows it as a `Filter:` on the CASE,
--     never an Index Cond. No index on sales.collection or .collection_id can
--     serve it.
--
-- THE FIX IS NOT NEW WORK - it is the shape the working sibling already uses.
-- `analytics_sales_summary` answers the same window from the same tables and
-- returns 200 (verified live the same hour: ?collections=candy_mlb -> 1,564
-- sales / $7,063.23). It does three things this function did not:
--   a. resolves the requested slugs (short OR long) to `collections.id` and
--      filters `s.collection_id = ANY($4)` - the BASE column, which is indexed;
--   b. hoists the bounds into local variables and compares them plainly
--      (`s.sold_at >= $1 AND s.sold_at < $2`), so runtime pruning applies;
--   c. reads `sales` + `pinnacle_sales` directly instead of through the view,
--      keeping the CASE in the PROJECTION where it costs nothing.
-- This migration gives the timeseries the same three properties. Same
-- signature, same RETURNS TABLE shape, same output vocabulary.
--
-- MEASURED, warm-vs-warm (cold numbers on this instance are the estate's IO
-- spell, not the query - the same read was 3.78 s cold and 11.3 ms warm):
--   candy_mlb, 30 d, BEFORE: statement timeout at 50 s (never completes)
--   candy_mlb, 30 d, AFTER : 11.3 ms / 819 buffers, "Subplans Removed: 7",
--                            Index Cond carrying BOTH collection_id and the
--                            date range on sales_2026 alone.
--   all collections, 30 d  : 253 ms / 20,095 buffers warm (93,844 rows),
--                            36.9 s the same query cold.
--
-- ⛔ WHAT THIS DOES NOT CLAIM. The unfiltered `window=all` call still reads
-- everything from the 2025 floor forward; it is now a PRUNED index-only scan
-- instead of three sequential scans, which is strictly better, but it is not
-- bounded work and it can still exceed the gateway cap on a cold, saturated
-- instance. A rollup is the answer there and is NOT in this migration.
--
-- ⚠ NO EQUIVALENCE CLAIM IS SMUGGLED IN. `sales.collection_id` is NULLABLE
-- (verified: attnotnull = false, with an FK to collections), so scoping an
-- UNFILTERED read by `collection_id = ANY(<all ids>)` would silently drop any
-- row whose id is null - the partial-read-as-fact shape. So the collection_id
-- predicate is added ONLY on the branch where the caller named collections,
-- where it is the semantics they asked for. The `p_collections IS NULL` branch
-- gets the sargable dates and nothing else.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.analytics_sales_timeseries is already service_role-only and stays that way - VERIFIED with has_function_privilege (not acl text): anon EXECUTE false, authenticated EXECUTE false, service_role EXECUTE true. Reached only through /api/analytics/sales/timeseries, a service-role route.
--
-- REVERT: re-apply the previous body, whose md5 is 7b027b90cd6fe48bb1833d78ab69aa91
-- (1,009 chars) - a single RETURN QUERY over `analytics_sales` with the
-- `IS NULL OR` predicates. Reverting restores the 500s.

DO $gate$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'analytics_sales_timeseries')
     IS DISTINCT FROM '7b027b90cd6fe48bb1833d78ab69aa91'
  THEN
    RAISE EXCEPTION 'analytics_sales_timeseries body changed since this migration was drafted (expected md5 7b027b90cd6fe48bb1833d78ab69aa91) - re-read the live object and redraft rather than overwriting it';
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
  v_sales_pred text := '';
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
    v_sales_pred := ' AND s.collection_id = ANY($4) ';
    IF NOT v_pin THEN
      v_pin_pred := ' AND false ';
    END IF;
  END IF;

  v_sql := format($q$
    SELECT b, coll, n, vol, avgp
    FROM (
      SELECT date_trunc(%3$L, w.sold_at)::date       AS b,
             w.collection                            AS coll,
             COUNT(*)::bigint                        AS n,
             COALESCE(ROUND(SUM(w.price_usd)::numeric, 2), 0)  AS vol,
             COALESCE(ROUND(AVG(w.price_usd)::numeric, 2), 0)  AS avgp
      FROM (
        SELECT s.sold_at, s.price_usd,
               CASE s.collection
                 WHEN 'nba_top_shot'   THEN 'topshot'
                 WHEN 'nfl_all_day'    THEN 'allday'
                 WHEN 'laliga_golazos' THEN 'golazos'
                 WHEN 'ufc_strike'     THEN 'ufc'
                 ELSE s.collection
               END AS collection
        FROM sales s
        WHERE s.sold_at >= $1 AND s.sold_at < $2 %1$s
        UNION ALL
        SELECT ps.sold_at, ps.sale_price_usd, 'pinnacle'::text
        FROM pinnacle_sales ps
        WHERE ps.sold_at >= $3 AND ps.sold_at < $2 %2$s
      ) w
      GROUP BY 1, 2
    ) t
    ORDER BY b, coll
  $q$, v_sales_pred, v_pin_pred, v_trunc);

  v_hi  := COALESCE(p_end_at, 'infinity'::timestamptz);
  v_plo := COALESCE(p_start_at, '-infinity'::timestamptz);
  v_lo  := GREATEST(v_plo, c_floor);

  IF p_collections IS NULL THEN
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo;
  ELSE
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, v_ids;
  END IF;
END;
$function$;
