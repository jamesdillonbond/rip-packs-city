-- 2026-11-25: Top Shot pack pulls that left the opener's wallet are read from the chain AT THE RIP'S BLOCK.
--
-- Why. 12-21 % of Top Shot rips a week carry no pull_value_usd, because price_recent_topshot_rips prices a rip
-- only when EVERY pulled Moment has a moments row. A 400-rip sample (11-12..11-24) put 394 of them on one
-- cause: a pulled Moment with no moments row. Every one of those Moments had been asked of the chain by
-- topshot_moment_hydrate_dispatch(_head) and answered `panic: no nft` -- the script borrows the Moment from
-- the opener's wallet at `block_height=sealed`, and the Moment had already been sold or moved. That outcome
-- is then not retried for 365 days. ~86K Top Shot pulls were in this state on 11-25 (22.5K April, 31.5K May,
-- 11.2K September, 4.4K October, 13.4K November 2026).
--
-- Fix. The same script, run at the rip's own block height (pack_rips.block_height), when the Moment was still
-- in the opener's wallet. Measured from pg_net on 11-25: 3 of 3 November pulls, 1 April and 1 September pull
-- all answered 200 with set / play / serial; a 2024 height answered 404 ("less than the spork root block
-- height 137390146"), so the lane only asks for heights at or above that root (pre-2026 pulls: ~800, left).
--
-- Shape.
--   * topshot_moment_hydrate_requests.at_block_height: NULL for the existing lanes; the height for this lane.
--   * topshot_moment_hydrate_dispatch_at_rip(p_max, p_page): walks the existing pull queue
--     (idx_ma_hydration_queue_desc) newest first behind its own backfill_state cursor, so a tick's cost is
--     bounded by p_page; asks once per Moment (any earlier at-height request excludes it, whatever its outcome).
--   * topshot_moment_hydrate_drain(): unchanged except that a row asked at a past height is written with
--     owner_address NULL -- the answer says what the Moment IS, not who holds it now.
--   * topshot_moment_hydrate_at_rip_tick(p_max): dispatch + one pipeline_runs row
--     ('topshot-moments-hydrate-at-rip'); its extra carries the last hour's at-height outcomes, so the
--     yield is read from the requests table, not from the dispatch count. The drain stays in pg_cron 469.
--   * Scheduled separately (pg_cron, '2-58/4 * * * *', 60 a tick) -- the minute between 603 (1-57/4) and
--     469 (3-59/4), so no tick bursts more than ~90 requests at the access node.
--
-- Revert: unschedule the at-rip job; restore the drain body from 20260924044634 (…_hydrate_drain_stubs_new_editions…);
-- DROP FUNCTION topshot_moment_hydrate_at_rip_tick(int), topshot_moment_hydrate_dispatch_at_rip(int,int);
-- ALTER TABLE topshot_moment_hydrate_requests DROP COLUMN at_block_height. Moments rows already written are
-- correct chain facts and stay.

ALTER TABLE public.topshot_moment_hydrate_requests ADD COLUMN IF NOT EXISTS at_block_height bigint;

CREATE INDEX IF NOT EXISTS idx_tmhr_nft_at_height
  ON public.topshot_moment_hydrate_requests (nft_id) WHERE at_block_height IS NOT NULL;

-- anon-exec: intentional — same signature re-created; REVOKE below re-asserts it; verified post-apply: anon EXECUTE false (topshot_moment_hydrate_drain)
CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_drain()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_payload jsonb; v_written int := 0; v_resolved int := 0; v_unmapped int := 0;
  v_no_nft int := 0; v_no_coll int := 0; v_err int := 0; v_timeout int := 0; v_429 int := 0;
BEGIN
  DROP TABLE IF EXISTS _hyd_resp;
  CREATE TEMP TABLE _hyd_resp ON COMMIT DROP AS
  SELECT q.request_id, q.nft_id, q.wallet, q.at_block_height, q.dispatched_at, r.status_code,
         CASE WHEN r.status_code = 200 AND r.content ~ '^"[A-Za-z0-9+/=]+"$'
              THEN convert_from(decode(trim(both '"' from r.content), 'base64'), 'UTF8')::jsonb
              ELSE NULL END AS cdc,
         CASE WHEN r.status_code = 200 THEN NULL ELSE left(r.content, 300) END AS body,
         CASE WHEN r.content LIKE '%panic: no nft%' THEN 'no_nft'
              WHEN r.content LIKE '%panic: no collection%' THEN 'no_collection' END AS panic,
         r.error_msg
    FROM public.topshot_moment_hydrate_requests q
    JOIN net._http_response r ON r.id = q.request_id
   WHERE q.drained_at IS NULL;

  -- Decode: a JSON-CDC Dictionary of String → String.
  DROP TABLE IF EXISTS _hyd_dec;
  CREATE TEMP TABLE _hyd_dec ON COMMIT DROP AS
  SELECT x.request_id, x.nft_id, x.wallet, x.at_block_height, x.status_code, x.body, x.panic, x.error_msg,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'setID')::int  AS set_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'playID')::int AS play_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'serial')::int AS serial_number,
         NULLIF((SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'sub'), '')::int AS sub_id
    FROM _hyd_resp x;

  -- 2026-09-23: catalog a Standard edition the chain just named but the table
  -- lacks (new drops). NULL-returning, set-inheriting, never invents a set.
  PERFORM public.ensure_topshot_edition_stub(s.set_id, s.play_id)
     FROM (SELECT DISTINCT set_id, play_id FROM _hyd_dec
            WHERE status_code = 200 AND set_id IS NOT NULL AND play_id IS NOT NULL
              AND COALESCE(sub_id, 0) = 0) s;

  -- Resolve editions: the parallel keys `set:play::sub`, a Standard `set:play`.
  DROP TABLE IF EXISTS _hyd_res;
  CREATE TEMP TABLE _hyd_res ON COMMIT DROP AS
  SELECT d.request_id, d.nft_id, d.wallet, d.at_block_height, d.status_code, d.body, d.panic, d.error_msg, d.serial_number, d.set_id,
         e.id AS edition_id
    FROM _hyd_dec d
    LEFT JOIN public.editions e
      ON d.status_code = 200 AND e.collection_id = v_coll
     AND e.external_id = CASE WHEN COALESCE(d.sub_id, 0) > 0
                              THEN d.set_id || ':' || d.play_id || '::' || d.sub_id
                              ELSE d.set_id || ':' || d.play_id END;

  -- 2026-11-25: a row read at a past block height names the Moment, not its current holder -> owner NULL.
  SELECT jsonb_agg(jsonb_build_object('nft_id', nft_id, 'edition_id', edition_id,
                                      'serial_number', serial_number,
                                      'owner_address', CASE WHEN at_block_height IS NULL THEN wallet END)),
         count(*)
    INTO v_payload, v_resolved
    FROM _hyd_res WHERE status_code = 200 AND edition_id IS NOT NULL AND serial_number IS NOT NULL;
  IF v_resolved > 0 THEN
    v_written := public.replace_topshot_moments_batch(v_payload);
  END IF;

  UPDATE public.topshot_moment_hydrate_requests q
     SET drained_at = now(), status_code = x.status_code,
         outcome = CASE
           WHEN x.status_code = 200 AND x.edition_id IS NOT NULL AND x.serial_number IS NOT NULL THEN 'written'
           WHEN x.status_code = 200 AND x.set_id IS NOT NULL THEN 'unmapped'
           WHEN x.status_code = 200 THEN 'error'   -- a 200 whose body did not decode
           WHEN x.status_code = 400 AND x.panic IS NOT NULL THEN x.panic
           ELSE 'error' END,
         error = CASE WHEN x.status_code = 200 THEN NULL ELSE COALESCE(x.error_msg, x.body) END
    FROM _hyd_res x WHERE x.request_id = q.request_id;

  SELECT count(*) FILTER (WHERE outcome = 'unmapped'), count(*) FILTER (WHERE outcome = 'no_nft'),
         count(*) FILTER (WHERE outcome = 'no_collection'), count(*) FILTER (WHERE outcome = 'error'),
         count(*) FILTER (WHERE status_code = 429)
    INTO v_unmapped, v_no_nft, v_no_coll, v_err, v_429
    FROM public.topshot_moment_hydrate_requests WHERE request_id IN (SELECT request_id FROM _hyd_res);

  -- Requests pg_net never answered.
  UPDATE public.topshot_moment_hydrate_requests
     SET drained_at = now(), outcome = 'timeout', error = 'no response within 3 min'
   WHERE drained_at IS NULL AND dispatched_at < now() - interval '3 minutes';
  GET DIAGNOSTICS v_timeout = ROW_COUNT;

  RETURN jsonb_build_object('drained', (SELECT count(*) FROM _hyd_res), 'resolved', v_resolved, 'written', v_written,
                            'unmapped', v_unmapped, 'no_nft', v_no_nft, 'no_collection', v_no_coll,
                            'error', v_err, 'http_429', v_429, 'timeout', v_timeout);
END $function$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_drain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_drain() TO service_role;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch_at_rip(p_max integer DEFAULT 60, p_page integer DEFAULT 3000)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_req bigint; v_n int := 0;
  v_state_id text := 'topshot-moments-hydrate-at-rip';
  -- Flow mainnet spork root (measured 2026-11-25 from a 404 body). Below it the access node answers 404;
  -- after the next spork, heights under the NEW root 404 too and are simply not asked again.
  v_spork_root bigint := 137390146;
  v_cursor text; v_cur_date timestamptz; v_cur_nft text;
  v_page_n int := 0; v_page_date timestamptz; v_page_nft text;
  v_last_date timestamptz; v_last_nft text; v_wrapped boolean := false;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  INSERT INTO public.backfill_state (id, cursor, total_ingested, status, notes)
  VALUES (v_state_id, NULL, 0, 'running',
          'At-rip chain hydrator cursor = <acquired_date>|<nft_id> of the last queue row examined; NULL = start a new pass from the newest pull')
  ON CONFLICT (id) DO NOTHING;
  SELECT cursor INTO v_cursor FROM public.backfill_state WHERE id = v_state_id;
  IF v_cursor IS NOT NULL AND v_cursor <> '' THEN
    v_cur_date := split_part(v_cursor, '|', 1)::timestamptz;
    v_cur_nft  := split_part(v_cursor, '|', 2);
  END IF;

  DROP TABLE IF EXISTS _rip_page;
  CREATE TEMP TABLE _rip_page ON COMMIT DROP AS
  SELECT ma.nft_id, ma.wallet, ma.acquired_date, ma.source_pack_rip_id
    FROM public.moment_acquisitions ma
   WHERE ma.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND ma.acquisition_method = 'pack_pull'
     AND ma.acquisition_confidence = 'verified'
     AND ma.acquired_date < now() - interval '1 hour'   -- the head lane owns the first hour
     AND (v_cur_date IS NULL OR (ma.acquired_date, ma.nft_id) < (v_cur_date, v_cur_nft))
   ORDER BY ma.acquired_date DESC, ma.nft_id DESC
   LIMIT GREATEST(p_page, p_max);
  SELECT count(*), min(acquired_date) INTO v_page_n, v_page_date FROM _rip_page;
  SELECT nft_id INTO v_page_nft FROM _rip_page ORDER BY acquired_date ASC, nft_id ASC LIMIT 1;

  FOR r IN
    SELECT p.nft_id, p.wallet, p.acquired_date, pr.block_height
      FROM _rip_page p
      JOIN public.pack_rips pr ON pr.id = p.source_pack_rip_id
     WHERE p.wallet ~ '^0x[0-9a-f]{16}$'
       AND pr.block_height >= v_spork_root
     ORDER BY p.acquired_date DESC, p.nft_id DESC
  LOOP
    EXIT WHEN v_n >= GREATEST(p_max, 0);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.moments m
                           WHERE m.nft_id = r.nft_id AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd');
    -- asked once at its height, whatever came back
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                           WHERE q.nft_id = r.nft_id AND q.at_block_height IS NOT NULL);
    -- another lane's request still in flight
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                           WHERE q.nft_id = r.nft_id AND q.drained_at IS NULL);
    v_req := net.http_post(
      url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=' || r.block_height,
      body := jsonb_build_object(
        'script', v_script,
        'arguments', jsonb_build_array(
          encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
          encode(convert_to('{"type":"UInt64","value":"' || r.nft_id || '"}', 'UTF8'), 'base64'))),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet, at_block_height)
    VALUES (v_req, r.nft_id, r.wallet, r.block_height);
    v_n := v_n + 1; v_last_date := r.acquired_date; v_last_nft := r.nft_id;
  END LOOP;

  IF v_n >= p_max AND v_last_date IS NOT NULL THEN
    UPDATE public.backfill_state SET cursor = v_last_date::text || '|' || v_last_nft, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  ELSIF v_page_n >= GREATEST(p_page, p_max) THEN
    UPDATE public.backfill_state SET cursor = v_page_date::text || '|' || v_page_nft, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  ELSE
    v_wrapped := true;
    UPDATE public.backfill_state SET cursor = NULL, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  END IF;
  RETURN jsonb_build_object('dispatched', v_n, 'examined', v_page_n, 'wrapped', v_wrapped);
END $function$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_dispatch_at_rip(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch_at_rip(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_at_rip_tick(p_max integer DEFAULT 60)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE v_disp jsonb; v_err text; v_hour jsonb;
BEGIN
  BEGIN
    v_disp := public.topshot_moment_hydrate_dispatch_at_rip(p_max, 3000);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  -- The yield, read from the outcome table: what the last hour's at-height requests came back as.
  SELECT jsonb_object_agg(COALESCE(outcome, 'in_flight'), n) INTO v_hour
    FROM (SELECT outcome, count(*) n FROM public.topshot_moment_hydrate_requests
           WHERE at_block_height IS NOT NULL AND dispatched_at > now() - interval '1 hour'
           GROUP BY 1) o;
  PERFORM public.log_pipeline_run('topshot-moments-hydrate-at-rip', v_err IS NULL,
    jsonb_build_object('dispatch', v_disp, 'last_hour_outcomes', COALESCE(v_hour, '{}'::jsonb),
                       'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('dispatch', v_disp, 'last_hour_outcomes', v_hour, 'error', v_err);
END $function$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_at_rip_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_at_rip_tick(integer) TO service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('topshot-moments-hydrate-at-rip', 30, 'info',
 'Added 2026-11-25: topshot_moment_hydrate_at_rip_tick() (pg_cron, 2-58/4) asks the Flow access node for Top Shot pack pulls that left the opener''s wallet, at the rip''s block height, so their moments rows exist and their rips can be priced. Drained by pg_cron 469. Yield in extra.last_hour_outcomes. If silent, those rips stay unpriced (pull_value_usd NULL), nothing is wrong on a page.',
 true, 60)
ON CONFLICT (pipeline) DO NOTHING;
