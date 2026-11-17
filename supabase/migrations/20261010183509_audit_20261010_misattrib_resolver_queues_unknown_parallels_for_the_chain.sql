-- audit_20261010_misattrib_resolver_queues_unknown_parallels_for_the_chain
-- anon-exec: unchanged (resolve_topshot_misattrib_via_atlas) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false 2026-10-10.
--
-- 2026-10-10 (known-issues #171, with #101). resolve_topshot_misattrib_via_atlas (20261010182920)
-- holds a candidate that Atlas calls a PARALLEL when topshot_moment_subeditions does not know its
-- subedition, because mapping it would fold the moment onto its base edition. On its first run 244
-- were held: 242 had NO subedition row at all, so nothing would ever resolve them. That is #171's
-- residual exactly ("parallel NFTs ... still fold until topshot_moment_subeditions covers them").
--
-- WHAT. One more step in the same statement: a held parallel with no subedition row is queued
-- there as pending (subedition NULL, base = the set:play Atlas names). get_topshot_subedition_targets
-- picks every NULL row, the chain lane (backfill-topshot-subeditions: TopShot.getMomentsSubedition,
-- ~20k/day against 13.4k pending) resolves it, and the next resolver tick maps the moment onto its
-- parallel edition. A NULL row reads exactly like no row to every consumer (remap and indexers act
-- only on > 0 / = 0). Pin claim 5 (the previous body reds it).
--
-- REVERT: re-apply the function from 20261010182920. Queued rows are subedition IS NULL with
-- base_external_id from Atlas; the chain lane resolves or keeps them.

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
