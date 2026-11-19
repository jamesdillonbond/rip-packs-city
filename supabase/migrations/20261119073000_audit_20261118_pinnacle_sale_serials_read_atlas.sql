-- audit_20261118_pinnacle_sale_serials_read_atlas
--
-- 2026-11-18 (PT, ~10:20 PM; Claude Code cloud; Trevor: "Keep going") -- #218 / #156.
-- pinnacle_sale_serials_tick fills pinnacle_sales.serial_number for serialised Pinnacle pins. Its remote
-- read was Disney's Studio GraphQL searchPinnacleMarketplaceHistory, HTTP 530 since 11-17 (reads table:
-- 9 http_530, 16 undecodable; last ok read 11-16 6:54 PM PT). A serial is a property of the NFT, and Atlas
-- NFTService/GetNFTs {product:'disney', nftIds:[...]} answers nfts[{id, serialNumber}] for a batch.
-- Measured 11-18: 40 of 40 random already-serialled sale NFTs -> Atlas serial agreed (0 disagree); 5 of 5
-- serial-less serialised sale NFTs answered. Scope: 78 pins / 138 NFTs, max 7 per pin.
--
-- WHAT. The local fill (step 1), the per-pin bookkeeping, statuses and retry rules are unchanged. Step 2
-- parses `nfts[]` instead of GraphQL edges; step 3 sends one GetNFTs read per pin over up to 100 of its
-- serial-less NFT ids (newest first) and records the request in atlas_ondemand_requests for the 4xx arm.
-- The 25 reads Studio left as undecodable / http_530 are reset so those pins are read again.
-- Pinned: supabase/tests/pinnacle_sale_serials_tick.sql + drift guard (re-pointed here).
--
-- REVERT: re-create pinnacle_sale_serials_tick from 20260928113619_audit_20260928_pinnacle_sale_serials.sql.

CREATE OR REPLACE FUNCTION public.pinnacle_sale_serials_tick(p_n integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_pin        CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_types      CONSTANT text[] := ARRAY['Limited Edition','Limited Event Edition','Legendary Edition','Genesis Edition'];
  v_local      int := 0;
  v_collected  int := 0;
  v_filled     int := 0;
  v_sent       int := 0;
BEGIN
  -- 1. LOCAL FILL: sources that already saw the NFT, only where they agree.
  WITH miss AS (
    SELECT s.id, s.nft_id
      FROM pinnacle_sales s
      JOIN pinnacle_catalog c ON c.render_id = s.render_id
     WHERE s.serial_number IS NULL AND s.nft_id IS NOT NULL
       AND c.edition_type = ANY (v_types)
  ), ids AS (
    SELECT DISTINCT nft_id FROM miss
  ), known AS (
    SELECT u.nft_id, min(u.serial_number) AS ser
      FROM (
        SELECT s.nft_id, s.serial_number FROM pinnacle_sales s JOIN ids USING (nft_id) WHERE s.serial_number > 0
        UNION ALL
        SELECT w.moment_id, w.serial_number FROM wallet_moments_cache w JOIN ids ON ids.nft_id = w.moment_id
         WHERE w.collection_id = v_pin AND w.serial_number > 0
        UNION ALL
        SELECT l.nft_id, l.serial_number FROM pinnacle_live_listings l JOIN ids USING (nft_id) WHERE l.serial_number > 0
      ) u
     GROUP BY u.nft_id
    HAVING count(DISTINCT u.serial_number) = 1
  ), upd AS (
    UPDATE pinnacle_sales s SET serial_number = k.ser
      FROM miss m JOIN known k ON k.nft_id = m.nft_id
     WHERE s.id = m.id AND s.serial_number IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_local FROM upd;

  -- 2. COLLECT finished (or abandoned) reads and fill from them.
  --    2026-11-18 (#218): the read is Atlas NFTService/GetNFTs over the pin's serial-less NFT ids
  --    (Studio searchPinnacleMarketplaceHistory is HTTP 530). A serial is a property of the NFT;
  --    40/40 Atlas serials agreed with ones already held (measured 11-18).
  WITH done AS (
    SELECT a.render_id, r.status_code, r.content
      FROM pinnacle_sale_serial_reads a
      LEFT JOIN net._http_response r ON r.id = a.request_id
     WHERE a.request_id IS NOT NULL
       AND (r.id IS NOT NULL OR a.dispatched_at < now() - interval '1 hour')
  ), parsed AS (
    SELECT d.render_id, d.status_code,
           -- coalesce: a 200 WITHOUT the array made this NULL, and a NULL `readable` fell through
           -- every CASE arm below to 'ok' -- an unreadable answer stamped as a clean read.
           coalesce(d.status_code = 200 AND d.content IS JSON OBJECT
            AND jsonb_typeof(d.content::jsonb->'nfts') = 'array', false) AS readable,
           false AS more,
           CASE WHEN d.status_code = 200 AND d.content IS JSON OBJECT
                THEN d.content::jsonb->'nfts' END AS edges
      FROM done d
  ), nodes AS (
    SELECT p.render_id, e->>'id' AS nft_id,
           CASE WHEN (e->>'serialNumber') ~ '^[0-9]{1,9}$'
                THEN (e->>'serialNumber')::int END AS ser
      FROM parsed p
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN p.readable THEN p.edges ELSE '[]'::jsonb END) e
  ), agreed AS (
    SELECT render_id, nft_id, min(ser) AS ser
      FROM nodes WHERE nft_id IS NOT NULL AND ser > 0
     GROUP BY render_id, nft_id HAVING count(DISTINCT ser) = 1
  ), fill AS (
    UPDATE pinnacle_sales s SET serial_number = g.ser
      FROM agreed g
     WHERE s.nft_id = g.nft_id AND s.render_id = g.render_id AND s.serial_number IS NULL
    RETURNING s.render_id
  ), per_pin AS (
    SELECT render_id, count(*) AS n FROM fill GROUP BY render_id
  ), stamp AS (
    UPDATE pinnacle_sale_serial_reads a SET
      request_id = NULL,
      checked_at = clock_timestamp(),
      filled     = coalesce(pp.n, 0),
      -- the retry cap counts CONSECUTIVE failures: a readable answer resets it
      attempts   = CASE WHEN x.readable THEN 0 ELSE a.attempts END,
      status = CASE
                 WHEN x.status_code IS NULL THEN 'no_response'
                 WHEN x.status_code <> 200  THEN 'http_' || x.status_code
                 WHEN NOT x.readable        THEN 'undecodable'
                 WHEN x.more                THEN 'partial'
                 ELSE 'ok' END
      FROM parsed x LEFT JOIN per_pin pp ON pp.render_id = x.render_id
     WHERE a.render_id = x.render_id
    RETURNING coalesce(pp.n, 0) AS n
  )
  SELECT count(*), coalesce(sum(n), 0) INTO v_collected, v_filled FROM stamp;

  -- 3. DISPATCH the next p_n serialised pins that still have a serial-less sale: one GetNFTs read of
  --    up to 100 of the pin's serial-less NFT ids (11-18: max 7 per pin across 78 pins).
  WITH todo AS (
    SELECT s.render_id, max(s.created_at) AS newest_missing
      FROM pinnacle_sales s
      JOIN pinnacle_catalog c ON c.render_id = s.render_id
     WHERE s.serial_number IS NULL AND s.nft_id IS NOT NULL
       AND c.edition_type = ANY (v_types)
     GROUP BY s.render_id
  ), nxt AS (
    SELECT t.render_id, c.edition_id::int AS edition_id,
           (SELECT jsonb_agg(z.nft_id) FROM (
              SELECT s2.nft_id FROM pinnacle_sales s2
               WHERE s2.render_id = t.render_id AND s2.serial_number IS NULL AND s2.nft_id ~ '^[0-9]{1,20}$'
               GROUP BY s2.nft_id ORDER BY max(s2.created_at) DESC LIMIT 100) z) AS ids
      FROM todo t
      JOIN pinnacle_catalog c ON c.render_id = t.render_id
      LEFT JOIN pinnacle_sale_serial_reads a ON a.render_id = t.render_id
     WHERE c.edition_id ~ '^[0-9]{1,9}$'
       AND (a.render_id IS NULL
            OR (a.request_id IS NULL
                AND ((a.status IN ('no_response', 'http_429') OR a.status LIKE 'http_5%') AND a.attempts < 5
                     OR t.newest_missing > a.checked_at)))
     ORDER BY (a.render_id IS NULL) DESC, a.checked_at NULLS FIRST, t.render_id
     LIMIT greatest(1, least(p_n, 60))
  ), ins AS (
    INSERT INTO pinnacle_sale_serial_reads AS a (render_id, edition_id, request_id, dispatched_at, attempts)
    SELECT n.render_id, n.edition_id,
           net.http_post(
             url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.NFTService/GetNFTs',
             headers := public.atlas_market_headers('disney'),
             body := jsonb_build_object('product', 'disney', 'nftIds', n.ids),
             timeout_milliseconds := 30000),
           clock_timestamp(), 1
      FROM nxt n
     WHERE n.ids IS NOT NULL
    ON CONFLICT (render_id) DO UPDATE SET
      request_id    = EXCLUDED.request_id,
      dispatched_at = EXCLUDED.dispatched_at,
      attempts      = a.attempts + 1
    RETURNING a.request_id
  ), att AS (
    -- the 4xx arm attributes a Cloudflare 403 through atlas_ondemand_requests
    INSERT INTO atlas_ondemand_requests (request_id, fn)
    SELECT request_id, 'pinnacle-sale-serials' FROM ins
    ON CONFLICT (request_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_sent FROM ins;

  RETURN jsonb_build_object('ok', true, 'local_filled', v_local, 'collected', v_collected,
                            'history_filled', v_filled, 'dispatched', v_sent);
END;
$function$;

REVOKE ALL ON FUNCTION public.pinnacle_sale_serials_tick(integer) FROM PUBLIC, anon, authenticated;

UPDATE public.pinnacle_sale_serial_reads
   SET status = 'no_response', attempts = 0
 WHERE status IN ('undecodable', 'http_530') AND request_id IS NULL;
