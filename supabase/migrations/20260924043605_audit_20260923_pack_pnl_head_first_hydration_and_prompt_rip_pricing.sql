-- 2026-09-23 · Pack P&L: newly-opened Top Shot packs get a pull value within
-- minutes-to-hours instead of never.
--
-- FINDING (measured 2026-09-23 ~9:50 PM PT): of Top Shot rips sealed 09-22 and
-- 09-23, 5 of 983 and 5 of 5,553 carry a pull_value_usd — the P&L column every
-- pack-P&L surface reads (sealed 09-21: 724 of 1,248). In a 400-rip sample of
-- the last 36 h, 400 of 400 had every acquisition row, 0 were missing an FMV,
-- and 358 were missing the `moments` row that maps an NFT to its edition
-- (932 of 1,030 acquisitions had no moments row at all).
--
-- MECHANISM: the chain hydrator (topshot_moment_hydrate_dispatch, jobid 469)
-- walks ALL verified pack-pull acquisitions backwards behind one cursor, 3,000
-- per 4-min tick, dispatching only for rows still unnamed. The walk is long,
-- so a pull made today waits for the whole pass to wrap before it is even
-- examined — the head starves. Same shape as the pack-sales indexers (fixed
-- today, _shared/pack-sales-walker.ts). On 09-23 a large drop produced ~19k
-- pulled moments in a day against ~2.5k hydrated/day.
--
-- FIX 1 — HEAD-FIRST HYDRATION: topshot_moment_hydrate_dispatch_head() takes
-- the newest unnamed pack pulls of the last 3 days first (index-ordered on
-- idx_ma_hydration_queue_desc; EXPLAIN 932 buffers / 5 ms for 150 rows), and
-- the tick calls it BEFORE the cursored walk. Same Cadence script, same request
-- table, same drain — so outcomes and the no_nft/no_collection back-off are
-- shared. Budget: 120 head + 80 walk per 4 min.
-- FIX 2 — PRICE RECENT RIPS PROMPTLY: price_recent_topshot_rips() writes
-- pull_value_usd for Top Shot rips sealed in the last 14 days that are still
-- NULL, using EXACTLY the all-or-nothing whole-pack rule of
-- backfill_pack_rip_metadata (every acquisition priced AND acquisitions =
-- moments_pulled), NULL -> positive only, never touching metadata_updated_at.
-- The hourly backfill's retry leg is 5 % of 2,000 = 100 rips/hour, below a
-- normal day's opens; this closes that gap. Two writers of one column, one rule:
-- both are pinned by name in the migration header of the other's next change.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-price-recent-topshot-rips');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'price-recent-topshot-rips';
--   re-apply topshot_moment_hydrate_tick from 20260923 prod (body = this one minus the head call),
--   DROP FUNCTION public.topshot_moment_hydrate_dispatch_head(integer);
--   DROP FUNCTION public.run_price_recent_topshot_rips(); DROP FUNCTION public.price_recent_topshot_rips(integer);
--
-- anon-exec: NOT intentional for topshot_moment_hydrate_dispatch_head / price_recent_topshot_rips / run_price_recent_topshot_rips — ops writers, ACL set below.

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch_head(p_max integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r record; v_req bigint; v_n int := 0;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  FOR r IN
    SELECT ma.nft_id, ma.wallet
      FROM public.moment_acquisitions ma
     WHERE ma.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND ma.acquisition_method = 'pack_pull'
       AND ma.acquisition_confidence = 'verified'
       AND ma.acquired_date > now() - interval '3 days'
       AND ma.wallet ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moments m
                        WHERE m.nft_id = ma.nft_id AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                        WHERE q.nft_id = ma.nft_id
                          AND q.dispatched_at > now() - CASE
                                WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                                WHEN q.outcome IS NULL THEN interval '10 minutes'
                                ELSE interval '1 day' END)
     ORDER BY ma.acquired_date DESC, ma.nft_id DESC
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
      body := jsonb_build_object(
        'script', v_script,
        'arguments', jsonb_build_array(
          encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
          encode(convert_to('{"type":"UInt64","value":"' || r.nft_id || '"}', 'UTF8'), 'base64'))),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet) VALUES (v_req, r.nft_id, r.wallet);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END
$fn$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_dispatch_head(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch_head(integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_tick(p_max integer DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '110s'
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v_drain jsonb; v_head jsonb; v_disp jsonb; v_err text; v_pruned int := 0;
BEGIN
  BEGIN
    v_drain := public.topshot_moment_hydrate_drain();
    -- 2026-09-23: HEAD FIRST. Today's pulls before the history walk (see migration header).
    v_head  := public.topshot_moment_hydrate_dispatch_head(120);
    v_disp  := public.topshot_moment_hydrate_dispatch(p_max);
    -- a written request is consulted by nothing once its moments row exists
    DELETE FROM public.topshot_moment_hydrate_requests
     WHERE outcome = 'written' AND drained_at < now() - interval '2 days';
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-moments-hydrate-chain', v_started,
    COALESCE((v_drain->>'drained')::int, 0), COALESCE((v_drain->>'written')::int, 0),
    COALESCE((v_drain->>'no_nft')::int, 0) + COALESCE((v_drain->>'no_collection')::int, 0) + COALESCE((v_drain->>'unmapped')::int, 0),
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('drain', v_drain, 'head', v_head, 'dispatch', v_disp, 'pruned', v_pruned, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('drain', v_drain, 'head', v_head, 'dispatch', v_disp, 'pruned', v_pruned, 'error', v_err);
END
$fn$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_tick(integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.price_recent_topshot_rips(p_limit integer DEFAULT 1500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _prtr;
  CREATE TEMP TABLE _prtr ON COMMIT DROP AS
  SELECT pr.id, pr.collection_id, pr.moments_pulled
    FROM public.pack_rips pr
   WHERE pr.collection_id = v_ts
     AND pr.sealed_at > now() - interval '14 days'
     AND pr.pull_value_usd IS NULL
   ORDER BY pr.sealed_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1500), 1), 5000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  -- The whole-pack, all-or-nothing rule of backfill_pack_rip_metadata, verbatim.
  WITH pv AS (
    SELECT c.id AS rip_id, SUM(fc.fmv_usd)::numeric(14,2) AS pull_value_usd
      FROM _prtr c
      JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
      LEFT JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = c.collection_id
      LEFT JOIN LATERAL (
        SELECT s.fmv_usd, s.collection_id
          FROM public.fmv_snapshots s
         WHERE s.edition_id = m.edition_id
         ORDER BY s.computed_at DESC
         LIMIT 1
      ) fc ON fc.collection_id = m.collection_id
     GROUP BY c.id, c.moments_pulled
    HAVING count(*) = count(fc.fmv_usd)
       AND count(*) = c.moments_pulled
  ), upd AS (
    UPDATE public.pack_rips pr SET pull_value_usd = pv.pull_value_usd
      FROM pv
     WHERE pr.id = pv.rip_id AND pr.pull_value_usd IS NULL AND pv.pull_value_usd > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  SELECT count(*) INTO v_left FROM public.pack_rips
   WHERE collection_id = v_ts AND sealed_at > now() - interval '14 days' AND pull_value_usd IS NULL;

  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null_14d', v_left);
END
$fn$;
REVOKE ALL ON FUNCTION public.price_recent_topshot_rips(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_recent_topshot_rips(integer) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.run_price_recent_topshot_rips()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v jsonb; v_err text;
BEGIN
  BEGIN
    v := public.price_recent_topshot_rips(1500);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
    v_err := SQLERRM;
  END;
  PERFORM public.log_pipeline_run('price-recent-topshot-rips', v_started,
    (v->>'candidates')::int, (v->>'priced')::int, NULL, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    COALESCE(v, '{}'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.run_price_recent_topshot_rips() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_price_recent_topshot_rips() TO service_role, postgres;

SELECT cron.schedule('rpc-price-recent-topshot-rips', '6-56/10 * * * *', 'SELECT public.run_price_recent_topshot_rips();');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, max_minutes_without_success)
VALUES ('price-recent-topshot-rips', 60, 'medium', 'Seeded 2026-09-23: pg_cron every 10 min -> 6x silent.', 120)
ON CONFLICT (pipeline) DO NOTHING;
