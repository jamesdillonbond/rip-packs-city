-- audit_20260928_pinnacle_sale_serials
--
-- WHY (register #156). The forward Pinnacle sales writer (/api/pinnacle-sales-
-- indexer, source 'on-chain') has never recorded a sale's serial; only the
-- one-time studio history drain did, and it finished in June 2026. Serials
-- matter only for the SERIALISED edition types (Limited / Limited Event /
-- Legendary / Genesis — lib/pinnacle/serialisation.ts; Open, Open Event and
-- Starter pins have none by design). Measured 2026-09-28: 9,279 sales of
-- serialised pins had no serial, 3,254 of them since 2026-07-01 (0 of those
-- carried one). The #1 / perfect serial-premium refit and every "Serial" cell
-- read these rows.
--
-- WHAT. A serial is a property of the NFT, so any source that has seen the
-- NFT answers it. public.pinnacle_sale_serials_tick(), every 10 minutes:
--   1. LOCAL FILL — from other pinnacle_sales rows, wallet_moments_cache and
--      pinnacle_live_listings, only where the sources agree on one value.
--      Measured: the three agree on all 2,423 NFTs they share (0 conflicts);
--      this fills 6,967 of the 9,279. ~115 ms, 22k buffers (EXPLAIN ANALYZE).
--   2. COLLECT the Disney Studio-GraphQL history answers dispatched last tick
--      (searchPinnacleMarketplaceHistory by edition_id, first 300: one request
--      covers a pin's whole history — the largest has 256 sales) and fill each
--      NFT's serial. Status per pin: ok / partial (more pages exist) / http_* /
--      undecodable / no_response.
--   3. DISPATCH the next p_n pins (serialised types) that still have a sale
--      without a serial — never-read first; a pin is re-read only when a NEW
--      serial-less sale arrived after its last read, or after a transient
--      failure (≤ 5 attempts). 304 pins remained after the local fill.
-- Only NULL serials are written; a present serial is never overwritten.
--
-- anon-exec: revoked (pinnacle_sale_serials_tick) — REVOKEd from PUBLIC, anon, authenticated below; pg_cron runs it as postgres.
--
-- Revert:
--   SELECT cron.unschedule('rpc-pinnacle-sale-serials');
--   DROP FUNCTION IF EXISTS public.pinnacle_sale_serials_tick(int);
--   DROP TABLE IF EXISTS public.pinnacle_sale_serial_reads;
--   Filled serials are true facts about the NFT; to undo them anyway (exact:
--   before this migration those two sources carried 0 serials — 6,519 +
--   2,760 NULLs on serialised pins, measured 2026-09-28):
--   UPDATE pinnacle_sales SET serial_number = NULL
--    WHERE source IN ('on-chain', 'on-chain-history-backfill') AND serial_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.pinnacle_sale_serial_reads (
  render_id     text PRIMARY KEY,
  edition_id    integer NOT NULL,
  request_id    bigint,
  dispatched_at timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  status        text,
  filled        integer,
  checked_at    timestamptz
);
COMMENT ON TABLE public.pinnacle_sale_serial_reads IS
  'One row per serialised Disney Pinnacle pin whose sales history was read from Studio GraphQL to fill pinnacle_sales.serial_number (pinnacle_sale_serials_tick, register #156). Service-role only.';
ALTER TABLE public.pinnacle_sale_serial_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_sale_serial_reads FROM PUBLIC, anon, authenticated;

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

  -- 2. COLLECT finished (or abandoned) history reads and fill from them.
  WITH done AS (
    SELECT a.render_id, r.status_code, r.content
      FROM pinnacle_sale_serial_reads a
      LEFT JOIN net._http_response r ON r.id = a.request_id
     WHERE a.request_id IS NOT NULL
       AND (r.id IS NOT NULL OR a.dispatched_at < now() - interval '1 hour')
  ), parsed AS (
    SELECT d.render_id, d.status_code,
           (d.status_code = 200 AND d.content IS JSON OBJECT
            AND jsonb_typeof(d.content::jsonb->'data'->'searchPinnacleMarketplaceHistory'->'edges') = 'array') AS readable,
           CASE WHEN d.status_code = 200 AND d.content IS JSON OBJECT
                THEN (d.content::jsonb->'data'->'searchPinnacleMarketplaceHistory'->'pageInfo'->>'hasNextPage') = 'true' END AS more,
           CASE WHEN d.status_code = 200 AND d.content IS JSON OBJECT
                THEN d.content::jsonb->'data'->'searchPinnacleMarketplaceHistory'->'edges' END AS edges
      FROM done d
  ), nodes AS (
    SELECT p.render_id, e->'node'->>'nft_id' AS nft_id,
           CASE WHEN (e->'node'->'nft'->>'serial_number') ~ '^[0-9]{1,9}$'
                THEN (e->'node'->'nft'->>'serial_number')::int END AS ser
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

  -- 3. DISPATCH the next p_n serialised pins that still have a serial-less sale.
  WITH todo AS (
    SELECT s.render_id, max(s.created_at) AS newest_missing
      FROM pinnacle_sales s
      JOIN pinnacle_catalog c ON c.render_id = s.render_id
     WHERE s.serial_number IS NULL AND s.nft_id IS NOT NULL
       AND c.edition_type = ANY (v_types)
     GROUP BY s.render_id
  ), nxt AS (
    SELECT t.render_id, c.edition_id::int AS edition_id
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
             url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
             headers := '{"Content-Type":"application/json","Origin":"https://disneypinnacle.com","Referer":"https://disneypinnacle.com/","User-Agent":"RipPacksCity/1.0 (www.rippackscity.com)"}'::jsonb,
             body := jsonb_build_object(
               'query', 'query($in: SearchPinnacleMarketplaceHistoryInput!){ searchPinnacleMarketplaceHistory(searchInput:$in){ pageInfo { hasNextPage } edges { node { nft_id nft { serial_number } } } } }',
               'variables', jsonb_build_object('in', jsonb_build_object(
                  'first', 300,
                  'filters', jsonb_build_array(jsonb_build_object('edition_id', jsonb_build_object('eq', n.edition_id)))))),
             timeout_milliseconds := 30000),
           clock_timestamp(), 1
      FROM nxt n
    ON CONFLICT (render_id) DO UPDATE SET
      request_id    = EXCLUDED.request_id,
      dispatched_at = EXCLUDED.dispatched_at,
      attempts      = a.attempts + 1
    RETURNING 1
  )
  SELECT count(*) INTO v_sent FROM ins;

  RETURN jsonb_build_object('ok', true, 'local_filled', v_local, 'collected', v_collected,
                            'history_filled', v_filled, 'dispatched', v_sent);
END;
$function$;

COMMENT ON FUNCTION public.pinnacle_sale_serials_tick(integer) IS
  'Fills pinnacle_sales.serial_number for serialised Disney Pinnacle pins: local sources first, then Studio GraphQL history reads (pg_net). Run by pg_cron rpc-pinnacle-sale-serials. Register #156; migration audit_20260928_pinnacle_sale_serials.';

REVOKE EXECUTE ON FUNCTION public.pinnacle_sale_serials_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_sale_serials_tick(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-pinnacle-sale-serials', '4-59/10 * * * *', 'SELECT public.pinnacle_sale_serials_tick(20)');
