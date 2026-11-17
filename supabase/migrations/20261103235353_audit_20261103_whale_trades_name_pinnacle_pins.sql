-- /analytics "Recent Whale Trades" printed EVERY Pinnacle trade as "Unknown moment"
-- (found 2026-11-03 ~3:50 PM PT, Claude Code local, by the mobile sweep; 11/3/2026, 3:53:15 PM PT at drafting).
--
-- MEASURED LIVE FIRST: the panel's top row was "Unknown moment #1 · Pinnacle $11.0k 27d ago".
-- analytics_sales_top_moves enriches with LEFT JOIN editions e ON e.id::text = t.edition_id, but a
-- pinnacle_sales row's edition_id is a PINNACLE key ("PIXR-GEN-PGEN:Genesis:1"), which matches no
-- editions row: 0 of the 5 largest Pinnacle sales in 30 d joined. Per the Pinnacle grain rule a pin is
-- a pinnacle_catalog row keyed by render_id; pinnacle_sales carries render_id, and it resolves 1:1
-- (pinnacle_catalog_pkey) for all five: Nemo & Dory, Flo, Galactic Carving Champ, Belle, Snow White.
--
-- FIX: carry render_id through both legs (NULL on the sales leg), LEFT JOIN pinnacle_catalog on it,
-- and name a row COALESCE(players.name, catalog.character_name) / COALESCE(sets.name,
-- catalog.set_name). Non-Pinnacle rows are unchanged: their render_id is NULL, so pc never matches
-- and COALESCE returns the existing value. Same signature, same RETURNS TABLE, still at most p_limit
-- rows enriched (one more PK probe per row).
--
-- BASED ON THE LIVE BODY, not the 20260920170000 file: live prosrc (md5 6c15a32c…) differs from
-- that file only in the wording of one comment block. The gate below refuses if live has moved.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.analytics_sales_top_moves is already service_role-only and stays that way - VERIFIED with information_schema.routine_privileges (service_role + postgres EXECUTE only). Reached only through /api/analytics/sales/top-moves, a service-role route.
--
-- REVERT: re-apply the previous body, md5 6c15a32cb6484f77a564514a128d218f (the
-- 20260920170000 body; it differs only in one comment). Reverting restores "Unknown moment".

DO $gate$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'analytics_sales_top_moves')
     IS DISTINCT FROM '6c15a32cb6484f77a564514a128d218f'
  THEN
    RAISE EXCEPTION 'analytics_sales_top_moves body changed since this migration was drafted (expected md5 6c15a32cb6484f77a564514a128d218f) - re-read the live object and redraft';
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

  -- LIMIT FIRST, ENRICH AFTER. The previous body LEFT JOINed editions, players
  -- and sets over EVERY sale in the window and only then applied
  -- ORDER BY ... LIMIT, so a 10-row panel paid for three joins across the whole
  -- range. Each source is now top-N'd on its own before anything is joined, the
  -- two are merged and re-limited, and the three enrichment joins run against at
  -- most p_limit rows.
  --
  -- The editions join keeps its ::text cast, and that is now harmless rather
  -- than fatal: pinnacle_sales.edition_id is TEXT while sales.edition_id is
  -- UUID, so the union has to be text - but the cast is applied to p_limit rows
  -- instead of to the whole window, where it was defeating editions' pkey index.
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
              s.transaction_hash::text      AS transaction_hash,
              NULL::text                    AS render_id
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
              NULL::text,
              ps.render_id::text
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
           COALESCE(p.name, pc.character_name)::text AS player_name,
           COALESCE(st.name, pc.set_name)::text      AS set_name,
           t.edition_id,
           t.moment_id,
           t.transaction_hash
    FROM top t
    LEFT JOIN editions e ON e.id::text = t.edition_id
    LEFT JOIN players  p ON p.id       = e.player_id
    LEFT JOIN sets     st ON st.id     = e.set_id
    -- 2026-11-03: a Pinnacle row's edition_id is a pinnacle key that matches no editions row, so every
    -- Pinnacle trade read "Unknown moment". A pin is a pinnacle_catalog row, keyed by render_id.
    LEFT JOIN pinnacle_catalog pc ON pc.render_id = t.render_id
    ORDER BY t.price_usd DESC, t.sold_at DESC
  $q$, v_sales_pred, v_pin_pred);

  IF p_collections IS NULL THEN
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, NULL::uuid[], p_limit;
  ELSE
    RETURN QUERY EXECUTE v_sql USING v_lo, v_hi, v_plo, v_ids, p_limit;
  END IF;
END;
$function$;
