-- Undercut-NULL Top Shot editions get priority edition-verify slots (2026-09-26, #149).
-- 20260926192206 / 192947 write edition_offers.low_ask NULL when an open listing under half the
-- floor exists but has not been re-observed in 24 h — neither price can be confirmed. An edition
-- VERIFICATION (the full Atlas book for that edition) settles it: it re-sees the listings still open
-- and closes the rest, and the next tick publishes the true floor. Measured ~1:00 PM PT on 30 such
-- editions probed by hand: the three that settled first all came back priced from the verified book
-- — 243:8287::21 $350, 274:9084::18 $14, and 264:9191::20 $39, where the two cheaper "open" listings
-- ($21, $29) turned out to be CLOSED. So neither the stale floor nor the older cheap listing is safe
-- to publish; only a verification answers it. The rotating dispatch (4 per tick, oldest-verified
-- first over ~14k editions) reaches an edition every ~12 days; these 1,238 editions need a daily one.
--
-- New lane: atlas_edition_verify_dispatch_undercut(p_max 3), pg_cron rpc-ts-edition-verify-undercut
-- at 4-59/5 (3 minutes after the tick's own 4 probes, so the Atlas requests do not burst together —
-- 30 dispatched at once drew 7 × 403 against ~6 % for the paced lane). Population: TS edition_offers
-- rows with low_ask NULL, an open listing seen within 30 d, not verified in 24 h, not in flight;
-- oldest-verified first. 864 probes/day at 3/tick. Candidate query ~0.5 s cold / 6.6k buffers.
-- Logs pipeline_runs 'ts-edition-verify-undercut' (rows_found = pool size before the in-flight
-- filter, NULL when nothing was dispatched; rows_written = probes dispatched); watchlisted.
--
-- REVERT: SELECT cron.unschedule('rpc-ts-edition-verify-undercut');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'ts-edition-verify-undercut';
--         DROP FUNCTION public.atlas_edition_verify_dispatch_undercut(integer);
-- anon-exec: atlas_edition_verify_dispatch_undercut (REVOKED from PUBLIC/anon/authenticated below; postgres via pg_cron, service_role)

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_dispatch_undercut(p_max integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); r record; v_req bigint; v_n int := 0; v_pool int; v_err text;
BEGIN
  BEGIN
    FOR r IN
      WITH inflight AS MATERIALIZED (
        SELECT q.error
          FROM public.topshot_atlas_market_requests q
         WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
      ), cand AS (
        SELECT DISTINCT m.atlas_edition_id, v.verified_at
          FROM public.edition_offers eo
          JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
          LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = m.atlas_edition_id
         WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.low_ask IS NULL
           AND (v.verified_at IS NULL OR v.verified_at < now() - interval '24 hours')
           AND EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                          AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
                          AND ev.price_cents > 0 AND ev.last_seen_at > now() - interval '30 days')
      ), sized AS (
        SELECT c.atlas_edition_id, c.verified_at, count(*) OVER () AS pool FROM cand c
      )
      SELECT s.atlas_edition_id, s.pool
        FROM sized s
        LEFT JOIN inflight i ON i.error = '__edition__' || s.atlas_edition_id
       WHERE i.error IS NULL
       ORDER BY s.verified_at ASC NULLS FIRST
       LIMIT GREATEST(p_max, 0)
    LOOP
      v_pool := r.pool;
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
        headers := public.atlas_market_headers('nba'),
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
      VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
      v_n := v_n + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-edition-verify-undercut', v_started, v_pool, v_n, 0, v_err IS NULL, v_err,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('dispatched', v_n, 'pool', v_pool, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('dispatched', v_n, 'pool', v_pool, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.atlas_edition_verify_dispatch_undercut(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_edition_verify_dispatch_undercut(integer) TO service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('ts-edition-verify-undercut', 20, 'medium',
        'pg_cron rpc-ts-edition-verify-undercut every 5 min (4-59/5): 3 priority Atlas edition-verify probes for Top Shot editions whose low_ask is NULL because an unconfirmed cheaper open listing undercuts the floor (#149). rows_found = pool (NULL when nothing dispatched), rows_written = probes. Added 2026-09-26.',
        45);

SELECT cron.schedule('rpc-ts-edition-verify-undercut', '4-59/5 * * * *', 'SELECT public.atlas_edition_verify_dispatch_undercut(3);');
