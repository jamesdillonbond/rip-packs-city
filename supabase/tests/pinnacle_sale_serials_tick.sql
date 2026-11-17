-- DB invariant: public.pinnacle_sale_serials_tick — fills pinnacle_sales.serial_number
-- for SERIALISED Disney Pinnacle pins (register #156). Added 2026-09-28.
--
-- Claims:
--   1. Local fill writes a serial only for a serialised edition type, only where
--      every source that saw the NFT agrees, and only into a NULL serial.
--   2. A pin that still has a serial-less sale is dispatched once (one history
--      read), and not again until a NEW serial-less sale arrives or a transient
--      failure is being retried.
--   3. A 200 history answer fills the NFTs it names (never overwriting a present
--      serial) and stamps the pin ok; a 500 stamps http_500 and is retried.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260928113619_audit_20260928_pinnacle_sale_serials.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
-- pg_net is stubbed: net.http_post hands out ids, net._http_response is a table.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text);
CREATE SEQUENCE net._req_seq START 1000;
CREATE TABLE net._requests (id bigint, body jsonb);
CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) RETURNS bigint
LANGUAGE plpgsql AS $$ DECLARE v bigint := nextval('net._req_seq'); BEGIN INSERT INTO net._requests VALUES (v, body); RETURN v; END $$;

CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, edition_type text, edition_id text);
CREATE TABLE public.pinnacle_sales (id text PRIMARY KEY, render_id text, nft_id text, serial_number int, created_at timestamptz DEFAULT now());
CREATE TABLE public.wallet_moments_cache (collection_id uuid, moment_id text, serial_number int);
CREATE TABLE public.pinnacle_live_listings (nft_id text, serial_number int);
CREATE TABLE public.pinnacle_sale_serial_reads (
  render_id text PRIMARY KEY, edition_id integer NOT NULL, request_id bigint, dispatched_at timestamptz,
  attempts integer NOT NULL DEFAULT 0, status text, filled integer, checked_at timestamptz);

-- >>> BEGIN verbatim pinnacle_sale_serials_tick >>>
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
-- <<< END verbatim pinnacle_sale_serials_tick <<<

\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
INSERT INTO public.pinnacle_catalog VALUES
  ('R1', 'Limited Edition', '101'), ('R2', 'Limited Edition', '102'), ('R3', 'Limited Edition', '103'),
  ('OPEN', 'Open Edition', '200');
INSERT INTO public.pinnacle_sales (id, render_id, nft_id, serial_number, created_at) VALUES
  ('S1', 'R1', 'N1', NULL, now() - interval '2 days'),   -- wmc knows N1 = 7
  ('S2', 'OPEN', 'N2', NULL, now() - interval '2 days'), -- unserialised: never filled
  ('S3', 'R3', 'N3', NULL, now() - interval '2 days'),   -- sources disagree (9 vs 10)
  ('S4', 'R2', 'N4', NULL, now() - interval '2 days'),   -- nobody knows N4: history read
  ('S5', 'R2', 'N5', 3,    now() - interval '2 days');   -- already has a serial
INSERT INTO public.wallet_moments_cache VALUES (:PIN::uuid, 'N1', 7), (:PIN::uuid, 'N2', 5), (:PIN::uuid, 'N3', 9);
INSERT INTO public.pinnacle_live_listings VALUES ('N3', 10);

-- ── tick 1: local fill + dispatch ────────────────────────────────────────────
SELECT public.pinnacle_sale_serials_tick(20);
SELECT _assert_eq((SELECT serial_number::text FROM public.pinnacle_sales WHERE id = 'S1'), '7', 'local fill: serialised pin, one agreeing source');
SELECT _assert((SELECT serial_number FROM public.pinnacle_sales WHERE id = 'S2') IS NULL, 'local fill never touches an unserialised edition type');
SELECT _assert((SELECT serial_number FROM public.pinnacle_sales WHERE id = 'S3') IS NULL, 'local fill skips an NFT whose sources disagree');
SELECT _assert((SELECT request_id FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2') IS NOT NULL, 'R2 (unknown NFT) is dispatched');
SELECT _assert_eq((SELECT count(*)::text FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R1'), '0', 'R1 (filled locally) is not read');
SELECT _assert_eq((SELECT (body->'variables'->'in'->'filters'->0->'edition_id'->>'eq') FROM net._requests r JOIN public.pinnacle_sale_serial_reads a ON a.request_id = r.id WHERE a.render_id = 'R2'), '102', 'the read filters by the pin''s edition_id');

-- ── the answers arrive: R2 = 200 (N4 -> 42, N5 -> 4), R3 = 500 ───────────────
INSERT INTO net._http_response SELECT request_id, 200,
  '{"data":{"searchPinnacleMarketplaceHistory":{"pageInfo":{"hasNextPage":false},"edges":[{"node":{"nft_id":"N4","nft":{"serial_number":"42"}}},{"node":{"nft_id":"N5","nft":{"serial_number":"4"}}}]}}}'
  FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2';
INSERT INTO net._http_response SELECT request_id, 500, 'oops' FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R3';

-- ── tick 2: collect ──────────────────────────────────────────────────────────
SELECT public.pinnacle_sale_serials_tick(20);
SELECT _assert_eq((SELECT serial_number::text FROM public.pinnacle_sales WHERE id = 'S4'), '42', 'history answer fills the NFT it names');
SELECT _assert_eq((SELECT serial_number::text FROM public.pinnacle_sales WHERE id = 'S5'), '3', 'a present serial is never overwritten');
SELECT _assert_eq((SELECT status FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2'), 'ok', 'R2 stamped ok');
SELECT _assert_eq((SELECT filled::text FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2'), '1', 'R2 filled count = rows written (1, not 2)');
SELECT _assert((SELECT request_id FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R3') IS NOT NULL, 'R3 (http_500) is retried: re-dispatched in the same tick');
SELECT _assert_eq((SELECT attempts::text FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R3'), '2', 'R3 attempt counted');

-- ── tick 3: nothing new for R2 -> not re-read; a new serial-less sale -> re-read ─
SELECT public.pinnacle_sale_serials_tick(20);
SELECT _assert((SELECT request_id FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2') IS NULL, 'R2 is not re-read without a new serial-less sale');
INSERT INTO public.pinnacle_sales (id, render_id, nft_id, serial_number, created_at) VALUES ('S6', 'R2', 'N6', NULL, now() + interval '1 minute');
SELECT public.pinnacle_sale_serials_tick(20);
SELECT _assert((SELECT request_id FROM public.pinnacle_sale_serial_reads WHERE render_id = 'R2') IS NOT NULL, 'a new serial-less sale re-reads R2');

SELECT '✓ pinnacle_sale_serials_tick: all assertions passed' AS result;

ROLLBACK;
