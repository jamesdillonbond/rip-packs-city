-- `/analytics/sales` "Biggest Sales" is the THIRD of that page's four panels
-- found 500ing, and the last one this pass fixes (2026-09-20 ~10:00 AM PT,
-- Claude Code cloud).
--
-- MEASURED LIVE FIRST: /api/analytics/sales/top-moves?collections=candy_mlb&window=l30
-- -> 500 {"error":"top_moves_failed"}. Same family as the timeseries defect
-- (migrations 20260920163600 / 20260920165000): it read the `analytics_sales`
-- VIEW with `(p_start_at IS NULL OR ...)` bounds and filtered on the view's
-- `collection` CASE expression, so no partition pruning and no usable index.
--
-- BUT IT CARRIES A THIRD DEFECT THE OTHER TWO DID NOT, and it is the expensive
-- one: it LEFT JOINed `editions`, `players` and `sets` across EVERY sale in the
-- window and only THEN applied `ORDER BY price_usd DESC LIMIT p_limit`. A
-- ten-row panel paid for three joins over the whole range - and the editions
-- join is `e.id::text = s.edition_id`, a cast on the join key, which defeats the
-- index on editions.id for every one of those rows.
--
-- FIX: top-N each source on its own, merge, re-limit, and only then enrich.
-- The three joins now run against at most p_limit rows.
--
-- ⚠ The `::text` cast STAYS and that is correct, not an oversight:
-- `pinnacle_sales.edition_id` is TEXT while `sales.edition_id` is UUID, so the
-- union column has to be text. What changes is that the cast now applies to
-- p_limit rows instead of to the whole window.
--
-- MEASURED, Top Shot 7 d (15,050 qualifying sales), warm-vs-warm:
--   before : statement timeout (the panel 500s)
--   after  : 657 ms / 9,841 buffers for the ordering scan
-- ⚠ 19.4 s for the SAME read cold, off 2,143 disk reads - the estate's IO spell,
-- not the query. ⛔ AND THE HONEST LIMIT OF THIS FIX: the ordering scan still
-- heap-fetches, because ORDER BY price_usd DESC over the window needs a column
-- set no single index covers (same root cause as R121). This makes the panel
-- WORK; it does not make it cheap. R121's covering index would fix both.
--
-- EQUIVALENCE, by output against an INDEPENDENT function: the new statement's
-- top 5 for candy_mlb / 30 d is rank 1 Junior Caminero #2 $203.72, 2 Munetaka
-- Murakami #1 $196.67, 3 Murakami #2 $193.96 - identical to what
-- `get_top_sales()` (a different function, reached through /api/market-analytics)
-- returns for the same collection and window, player and set names included.
--
-- ⚠ PARAMETER NUMBERING HAS A DELIBERATE GAP. On the unfiltered branch `$4`
-- (the collection-id array) is never referenced while `$5` (p_limit) is.
-- EXECUTE ... USING accepts that - verified on this instance before applying,
-- not assumed - so the two branches can share one parameter list.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.analytics_sales_top_moves is already service_role-only and stays that way - VERIFIED with has_function_privilege (not acl text): anon EXECUTE false, service_role EXECUTE true. Reached only through /api/analytics/sales/top-moves, a service-role route.
--
-- REVERT: re-apply the previous body, md5 a697c73d9903d30f7609e63fd7624fda
-- (820 chars) - a single RETURN QUERY over `analytics_sales` with three LEFT
-- JOINs ahead of the LIMIT. Reverting restores the 500.

DO $gate$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'analytics_sales_top_moves')
     IS DISTINCT FROM 'a697c73d9903d30f7609e63fd7624fda'
  THEN
    RAISE EXCEPTION 'analytics_sales_top_moves body changed since this migration was drafted (expected md5 a697c73d9903d30f7609e63fd7624fda) - re-read the live object and redraft';
  END IF;
END
$gate$;

CREATE OR REPLACE FUNCTION public.analytics_sales_top_moves(p_start_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_collections text[] DEFAULT NULL::text[], p_limit integer DEFAULT 20)
 RETURNS TABLE(rank integer, collection text, serial_number integer, price_usd numeric, buyer_address text, seller_address text, marketplace text, sold_at timestamp with time zone, player_name text, set_name text, edition_id text, moment_id text, transaction_hash text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
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
    v_sales_pred := ' AND s.collection_id = ANY($4) ';
  END IF;

  -- ⭐ LIMIT FIRST, ENRICH AFTER. The previous body LEFT JOINed editions,
  -- players and sets over EVERY sale in the window and only then applied
  -- ORDER BY ... LIMIT, so a 10-row panel paid for three joins across the whole
  -- range. Each source is now top-N'd on its own before anything is joined, the
  -- two are merged and re-limited, and the three enrichment joins run against at
  -- most p_limit rows.
  --
  -- ⚠ The editions join keeps its `::text` cast, and that is now harmless
  -- rather than fatal: pinnacle_sales.edition_id is TEXT while sales.edition_id
  -- is UUID, so the union has to be text and the cast is unavoidable - but it is
  -- applied to p_limit rows instead of to the whole window, where it was
  -- defeating the index on editions.id.
  v_sql := format($q$
    WITH src AS (
      (SELECT s.collection                  AS coll_raw,
              s.serial_number               AS serial_number,
              s.price_usd                   AS price_usd,
              s.buyer_address::text         AS buyer_address,
              s.seller_address::text        AS seller_address,
              s.marketplace::text           AS marketplace,
              s.sold_at                     AS sold_at,
              s.edition_id::text            AS edition_id,
              s.moment_id::text             AS moment_id,
              s.transaction_hash::text      AS transaction_hash
       FROM sales s
       WHERE s.sold_at >= $1 AND s.sold_at < $2 AND s.price_usd > 0 %1$s
       ORDER BY s.price_usd DESC, s.sold_at DESC
       LIMIT $5)
      UNION ALL
      (SELECT 'pinnacle'::text,
              ps.serial_number,
              ps.sale_price_usd::numeric,
              ps.buyer_address::text,
              ps.seller_address::text,
              'pinnacle'::text,
              ps.sold_at,
              ps.edition_id::text,
              NULL::text,
              NULL::text
       FROM pinnacle_sales ps
       WHERE ps.sold_at >= $3 AND ps.sold_at < $2 AND ps.sale_price_usd > 0 %2$s
       ORDER BY ps.sale_price_usd DESC, ps.sold_at DESC
       LIMIT $5)
    ),
    top AS (
      SELECT * FROM src ORDER BY price_usd DESC, sold_at DESC LIMIT $5
    )
    SELECT ROW_NUMBER() OVER (ORDER BY t.price_usd DESC, t.sold_at DESC)::int AS rank,
           (CASE t.coll_raw
              WHEN 'nba_top_shot'   THEN 'topshot'
              WHEN 'nfl_all_day'    THEN 'allday'
              WHEN 'laliga_golazos' THEN 'golazos'
              WHEN 'ufc_strike'     THEN 'ufc'
              ELSE t.coll_raw
            END)::text AS collection,
           t.serial_number,
           t.price_usd,
           t.buyer_address,
           t.seller_address,
           t.marketplace,
           t.sold_at,
           p.name::text  AS player_name,
           st.name::text AS set_name,
           t.edition_id,
           t.moment_id,
           t.transaction_hash
    FROM top t
    LEFT JOIN editions e ON e.id::text = t.edition_id
    LEFT JOIN players  p ON p.id       = e.player_id
    LEFT JOIN sets     st ON st.id     = e.set_id
    ORDER BY t.price_usd DESC, t.sold_at DESC
  $q$, v_sales_pred, v_pin_pred);

  IF p_collections IS NULL THEN
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, NULL::uuid[], p_limit;
  ELSE
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, v_ids, p_limit;
  END IF;
END;
$function$;
