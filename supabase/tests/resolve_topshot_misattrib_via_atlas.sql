-- DB invariant: public.resolve_topshot_misattrib_via_atlas -- the independent resolver known-issues
-- #101 asked for: maps an open Top Shot misattribution candidate to its (set, play, serial) from
-- Atlas (Dapper's own marketplace index), and reads Atlas {nftId} for candidates with no events.
-- Claims:
--   1. a candidate whose Atlas events agree on one (set, play), serial and parallel label is mapped
--      (source 'atlas_nft_events'); events that disagree map nothing;
--   2. ⛔ no parallel fold: a Standard moment the subedition table calls a parallel, and a parallel
--      moment the subedition table does not know, are HELD, not mapped; a parallel whose subedition
--      is known is mapped;
--   3. a candidate with no events and no attempt in 30 days gets one {nftId} read, tagged
--      '__misattrib__<id>', and an attempt row; one attempted within 30 days does not; an
--      already-mapped candidate is ignored;
--   4. a re-run with nothing new maps and dispatches nothing; a failure is logged ok=false;
--   5. (2026-10-10, #171) a held parallel with no subedition row is queued there as pending (NULL),
--      so the chain lane resolves it and a later tick maps it.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010183509_audit_20261010_misattrib_resolver_queues_unknown_parallels_for_the_chain.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE SEQUENCE net._req_seq START 500;
CREATE TABLE net._sent (id bigint, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), body) RETURNING id $$;
CREATE FUNCTION public.atlas_market_headers(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE TABLE public.mv_topshot_misattrib_candidates (nft_id text);
CREATE TABLE public.topshot_misattrib_onchain_map (nft_id text PRIMARY KEY, set_id_onchain int, play_id_onchain int,
  serial_number int, resolved_at timestamptz, source text);
CREATE TABLE public.topshot_moment_subeditions (nft_id text PRIMARY KEY, base_external_id text, subedition_id smallint);
CREATE TABLE public.topshot_atlas_market_events (product text, nft_id text, set_id_onchain int, play_id_onchain int,
  serial_number int, parallel text);
CREATE TABLE public.topshot_atlas_market_requests (request_id bigint PRIMARY KEY, product text, offset_at int, error text);
CREATE TABLE public.topshot_misattrib_atlas_attempts (nft_id text PRIMARY KEY, attempted_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 1);
CREATE TABLE public._runs (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
  RETURNS void LANGUAGE sql AS $$ INSERT INTO public._runs VALUES ($1, $6, $11) $$;

CREATE OR REPLACE FUNCTION public.resolve_topshot_misattrib_via_atlas(p_max integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_open    int := 0;
  v_mapped  int := 0;
  v_held    int := 0;
  v_queued  int := 0;
  v_n       int := 0;
  v_req     bigint;
  r         record;
  v_err     text;
BEGIN
  BEGIN
    -- 1. COLLECT. An open target (a misattribution candidate with no on-chain map row) whose
    --    Atlas events agree on ONE (set, play), ONE serial and ONE parallel label is mapped from
    --    them. Atlas is Dapper's own index, independent of the sales being corrected.
    --    ⛔ The map has no subedition: remap_topshot_from_onchain_map picks the parallel edition
    --    from topshot_moment_subeditions. So a Standard moment is written unless that table says
    --    it is a parallel, and a parallel moment is written ONLY when that table already knows its
    --    subedition -- otherwise it would fold onto its base edition (#171's class). Held ones stay open.
    WITH open_t AS MATERIALIZED (
      SELECT c.nft_id FROM public.mv_topshot_misattrib_candidates c
       WHERE NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id)
    ), ev AS (
      SELECT e.nft_id, min(e.set_id_onchain) AS s, min(e.play_id_onchain) AS p, min(e.serial_number) AS ser,
             bool_and(e.parallel = 'Standard') AS std
        FROM public.topshot_atlas_market_events e
        JOIN open_t o ON o.nft_id = e.nft_id
       WHERE e.product = 'nba'
       GROUP BY e.nft_id
      HAVING count(DISTINCT (e.set_id_onchain, e.play_id_onchain)) = 1
         AND count(DISTINCT e.serial_number) = 1
         AND count(DISTINCT e.parallel) = 1
         AND bool_and(e.set_id_onchain IS NOT NULL AND e.play_id_onchain IS NOT NULL
                      AND e.serial_number IS NOT NULL AND e.parallel IS NOT NULL)
    ), ok AS (
      SELECT ev.* FROM ev
        LEFT JOIN public.topshot_moment_subeditions sb ON sb.nft_id = ev.nft_id
       WHERE (ev.std AND COALESCE(sb.subedition_id, 0) = 0)
          OR (NOT ev.std AND COALESCE(sb.subedition_id, 0) > 0)
    ), ins AS (
      INSERT INTO public.topshot_misattrib_onchain_map (nft_id, set_id_onchain, play_id_onchain, serial_number, resolved_at, source)
      SELECT ok.nft_id, ok.s, ok.p, ok.ser, now(), 'atlas_nft_events' FROM ok
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    ), queued AS (
      -- a held PARALLEL the subedition table has never seen is queued there (subedition NULL =
      -- pending; base = the set:play Atlas names) for the chain lane (backfill-topshot-subeditions,
      -- TopShot.getMomentsSubedition) to resolve; the next tick then maps it. (2026-10-10, #171)
      INSERT INTO public.topshot_moment_subeditions (nft_id, base_external_id, subedition_id)
      SELECT ev.nft_id, ev.s::text || ':' || ev.p::text, NULL FROM ev
       WHERE NOT ev.std
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_subeditions sb WHERE sb.nft_id = ev.nft_id)
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM open_t), (SELECT count(*) FROM ins), (SELECT count(*) FROM ev) - (SELECT count(*) FROM ok),
           (SELECT count(*) FROM queued)
      INTO v_open, v_mapped, v_held, v_queued;

    -- 2. DISPATCH. Up to p_max open targets that have NO Atlas events and no attempt in 30 days
    --    get one {nftId} read; atlas_market_drain ingests the answer into the events table and the
    --    next tick collects it. A moment never traded on Dapper's marketplace returns nothing and
    --    waits 30 days. The attempt is recorded here, not read back from the request table
    --    (pruned after 24 h), so a never-listed moment cannot be re-probed daily and starve the rest.
    FOR r IN
      SELECT c.nft_id
        FROM public.mv_topshot_misattrib_candidates c
       WHERE c.nft_id ~ '^[0-9]{1,15}$'
         AND NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_onchain_map m WHERE m.nft_id = c.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events e WHERE e.nft_id = c.nft_id AND e.product = 'nba')
         AND NOT EXISTS (SELECT 1 FROM public.topshot_misattrib_atlas_attempts a
                          WHERE a.nft_id = c.nft_id AND a.attempted_at > now() - interval '30 days')
       ORDER BY c.nft_id
       LIMIT GREATEST(p_max, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nba', 'nftId', r.nft_id, 'limit', 50),
        headers := public.atlas_market_headers('nba'),
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
      VALUES (v_req, 'nba', -3, '__misattrib__' || r.nft_id);
      INSERT INTO public.topshot_misattrib_atlas_attempts (nft_id, attempted_at, attempts)
      VALUES (r.nft_id, now(), 1)
      ON CONFLICT (nft_id) DO UPDATE SET attempted_at = EXCLUDED.attempted_at,
                                         attempts = topshot_misattrib_atlas_attempts.attempts + 1;
      v_n := v_n + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_mapped := 0; v_n := 0; v_queued := 0;
  END;

  PERFORM public.log_pipeline_run(
    'topshot-misattrib-atlas-resolver', v_started, v_open, v_mapped, v_held,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('open', v_open, 'mapped', v_mapped, 'held_parallel_or_contradicted', v_held,
                       'queued_for_subedition', v_queued, 'dispatched', v_n, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('ok', v_err IS NULL, 'open', v_open, 'mapped', v_mapped, 'held', v_held,
                            'queued', v_queued, 'dispatched', v_n, 'error', v_err);
END
$function$;

INSERT INTO public.mv_topshot_misattrib_candidates SELECT x FROM unnest(ARRAY['101','102','103','104','105','106','107','108','109']) x;
INSERT INTO public.topshot_misattrib_onchain_map VALUES ('109', 1, 1, 1, now() - interval '1 year', NULL);
INSERT INTO public.topshot_moment_subeditions VALUES ('102', '20:5', 4), ('104', '20:6', 3);
INSERT INTO public.topshot_atlas_market_events VALUES
  ('nba', '101', 10, 1, 7, 'Standard'), ('nba', '101', 10, 1, 7, 'Standard'),   -- agree, Standard, no sub row -> mapped
  ('nba', '102', 20, 5, 9, 'Rippled'),                                          -- parallel, sub known      -> mapped
  ('nba', '103', 20, 7, 3, 'Vortex'),                                           -- parallel, sub unknown    -> held
  ('nba', '104', 20, 6, 2, 'Standard'),                                         -- Standard, sub says 3     -> held
  ('nba', '105', 30, 1, 4, 'Standard'), ('nba', '105', 30, 1, 5, 'Standard');   -- serials disagree         -> nothing
INSERT INTO public.topshot_misattrib_atlas_attempts VALUES ('107', now() - interval '2 days', 1), ('108', now() - interval '40 days', 1);

SELECT _assert_eq((public.resolve_topshot_misattrib_via_atlas(5)->>'mapped'), '2', 'c1/c2 two mapped');
SELECT _assert_eq((SELECT string_agg(nft_id || '=' || set_id_onchain || ':' || play_id_onchain || '#' || serial_number || '/' || source, ',' ORDER BY nft_id)
                     FROM public.topshot_misattrib_onchain_map WHERE nft_id <> '109'),
  '101=10:1#7/atlas_nft_events,102=20:5#9/atlas_nft_events', 'c1/c2 the agreeing Standard and the known parallel, nothing else');
SELECT _assert_eq((SELECT extra->>'held_parallel_or_contradicted' FROM public._runs ORDER BY ctid DESC LIMIT 1), '2', 'c2 the unknown parallel and the contradicted Standard are held');
SELECT _assert_eq((SELECT string_agg(nft_id || '=' || base_external_id || '/' || coalesce(subedition_id::text, 'NULL'), ',' ORDER BY nft_id)
                     FROM public.topshot_moment_subeditions WHERE nft_id NOT IN ('102', '104')),
  '103=20:7/NULL', 'c2 (#171) the held unknown parallel is queued for the chain lane, pending (NULL), base from Atlas');
SELECT _assert_eq((SELECT string_agg(body->>'nftId', ',' ORDER BY id) FROM net._sent), '106,108',
  'c3 no events + no recent attempt -> one read each; recent attempt (107), events (101-105) and mapped (109) skipped');
SELECT _assert_eq((SELECT string_agg(error, ',' ORDER BY request_id) FROM public.topshot_atlas_market_requests), '__misattrib__106,__misattrib__108', 'c3 tagged requests');
SELECT _assert_eq((SELECT attempts::text FROM public.topshot_misattrib_atlas_attempts WHERE nft_id = '108'), '2', 'c3 attempt counted');

SELECT _assert_eq((public.resolve_topshot_misattrib_via_atlas(5)->>'dispatched'), '0', 'c4 re-run dispatches nothing');
SELECT _assert_eq((SELECT extra->>'mapped' FROM public._runs ORDER BY ctid DESC LIMIT 1), '0', 'c4 re-run maps nothing');

ALTER TABLE public.topshot_misattrib_onchain_map RENAME TO x_map;
SELECT _assert_eq((public.resolve_topshot_misattrib_via_atlas(5)->>'ok'), 'false', 'c4 failure reported');
SELECT _assert_eq((SELECT ok::text FROM public._runs ORDER BY ctid DESC LIMIT 1), 'false', 'c4 failure logged');

ROLLBACK;
