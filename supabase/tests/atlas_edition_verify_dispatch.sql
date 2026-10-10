-- DB invariant: public.atlas_edition_verify_dispatch -- picks the Top Shot editions whose Atlas
-- snapshot is re-fetched next (called by atlas_listing_verify_tick, pg_cron jobid 466).
-- Claims:
--   1. never-verified first, then the stalest verified; nothing verified within 24 h;
--   2. (2026-10-10, #85) an edition whose last snapshot was INCOMPLETE (more than one 200-row
--      page) waits 30 days, not 24 h -- longer than the rotation's ~11-day cycle, or the wait changes
--      nothing -- so its calls go to editions that can conclude; once 30 days old it is eligible again;
--   3. an edition with a probe in flight is not dispatched twice; each dispatch records its request.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010181823_audit_20261010_edition_verify_incomplete_wait_exceeds_the_rotation.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE SEQUENCE net._req_seq START 100;
CREATE TABLE net._sent (id bigint, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), body) RETURNING id $$;
CREATE FUNCTION public.atlas_market_headers(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE TABLE public.edition_offers (collection_id uuid, external_id text, updated_at timestamptz);
CREATE TABLE public.topshot_atlas_edition_map (external_id text, atlas_edition_id text);
CREATE TABLE public.topshot_atlas_market_events (product text, atlas_edition_id text, completed boolean, last_seen_at timestamptz);
CREATE TABLE public.topshot_atlas_edition_verified (atlas_edition_id text PRIMARY KEY, verified_at timestamptz, complete boolean,
  open_listings int, open_offers int, total_count int);
CREATE TABLE public.topshot_atlas_market_requests (request_id bigint, product text, offset_at int, error text,
  drained_at timestamptz, dispatched_at timestamptz DEFAULT now());

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_dispatch(p_max integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_req bigint; v_n int := 0;
BEGIN
  FOR r IN
    WITH inflight AS MATERIALIZED (
      -- the probes dispatched in the last 10 min and not yet drained: 10–16 rows, read once
      SELECT q.error
        FROM public.topshot_atlas_market_requests q
       WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
    ), cand AS (
      -- editions with an edition_offers row (the readers' surface) …
      SELECT m.atlas_edition_id, eo.updated_at AS stale_at
        FROM public.edition_offers eo
        JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
       WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      UNION ALL
      -- … and editions carrying an open offer or listing in our events
      SELECT ev.atlas_edition_id, min(ev.last_seen_at)
        FROM public.topshot_atlas_market_events ev
       WHERE ev.product = 'nba' AND NOT ev.completed AND ev.atlas_edition_id IS NOT NULL
       GROUP BY ev.atlas_edition_id
    )
    SELECT c.atlas_edition_id, min(c.stale_at) AS stale_at
      FROM cand c
      LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = c.atlas_edition_id
      LEFT JOIN inflight i ON i.error = '__edition__' || c.atlas_edition_id
     WHERE c.atlas_edition_id IS NOT NULL
       AND (v.verified_at IS NULL OR v.verified_at < now() - interval '24 hours')
       -- 2026-10-10 (#85): an edition whose last snapshot was INCOMPLETE (Atlas totalCount
       -- capped at 201 = more than one 200-row page) can never conclude -- its history only
       -- grows -- and its newest events already reach us through the firehose. It waits 30 days
       -- instead of 24 h, so the calls go to editions that CAN close their stale listings.
       -- ⚠ The wait must EXCEED the rotation's cycle (~11 days at ~1,236 calls/day over 14,052
       -- editions) or it changes nothing: 7 days was tried first and is a no-op in steady state.
       AND NOT (v.complete IS FALSE AND v.verified_at > now() - interval '30 days')
       AND i.error IS NULL
     GROUP BY c.atlas_edition_id, v.verified_at
     ORDER BY COALESCE(v.verified_at, '-infinity'::timestamptz) ASC, min(c.stale_at) ASC NULLS FIRST
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
    VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $function$;

INSERT INTO public.edition_offers SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'x' || g, now() - interval '1 day'
  FROM unnest(ARRAY['1','2','3','4','5','6']) g;
INSERT INTO public.topshot_atlas_edition_map SELECT 'x' || g, 'E' || g FROM unnest(ARRAY['1','2','3','4','5','6']) g;
INSERT INTO public.topshot_atlas_edition_verified VALUES
  ('E2', now() - interval '3 days', true,  0, 0, 40),    -- complete, stale       -> eligible
  ('E3', now() - interval '20 days', false, 9, 9, 201),  -- incomplete, 20 d      -> still waits
  ('E4', now() - interval '31 days', false, 9, 9, 201),  -- incomplete, 31 d      -> eligible again
  ('E5', now() - interval '2 hours', true, 0, 0, 12),    -- verified in 24 h      -> skipped
  ('E6', now() - interval '5 days', true,  0, 0, 50);    -- complete, stale, but in flight
INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error, drained_at, dispatched_at)
  VALUES (1, 'nba', -4, '__edition__E6', NULL, now() - interval '2 minutes');

SELECT _assert_eq((public.atlas_edition_verify_dispatch(10)->>'dispatched'), '3', 'c1-3 three editions dispatched');
SELECT _assert_eq((SELECT string_agg(body->>'editionId', ',' ORDER BY id) FROM net._sent), 'E1,E4,E2',
  'c1/c2 never-verified first, then stalest; incomplete-within-30d (E3), verified-24h (E5) and in-flight (E6) skipped');
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_atlas_market_requests WHERE error IN ('__edition__E1','__edition__E4','__edition__E2') AND offset_at = -4), '3',
  'c3 each dispatch records its request');
SELECT _assert_eq((public.atlas_edition_verify_dispatch(10)->>'dispatched'), '0', 'c3 nothing dispatched twice while in flight');

ROLLBACK;
