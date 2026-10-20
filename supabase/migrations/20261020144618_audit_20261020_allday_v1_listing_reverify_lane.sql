-- 2026-10-20 (PT) — known-issues #198: a recurring on-chain re-verify for open NFL All Day V1 listings.
-- Cowork cloud, Trevor: "Keep going".
--
-- Why: the V2 storefront reconciler re-verifies direct_v2 / storefront_v2 rows but by design never touches V1
-- (lib/golazos/storefront-reconcile.ts), and a V1 row closes only on a ListingCompleted event. A V1 ask whose NFT
-- leaves the seller's collection emits no event and stayed on the floor: 10-20 measured 464 dead of 10,513 never-verified
-- open V1 asks (287 were their edition's floor), closed by 20261020143828.
--
-- What: hourly pg_cron job rpc-allday-v1-listing-reverify (:24, a minute the 4-minute Flow REST hydrate lanes leave free)
-- calls allday_v1_reverify_tick(12):
--   1. drain  — reads net._http_response for its own dispatched scripts (ids recorded at dispatch, never inferred):
--               'live' stamps verified_at; 'ghost' / 'gone' / 'purchased' close the row (ghosted / vanished / purchased);
--               'unknown', '_storefront: none' and any non-200 change nothing (counted in extra). A request with no
--               response after 10 min is drained as a timeout.
--   2. dispatch — up to p_max scripts of <=250 ids each (same seller), over open V1 rows never verified or verified
--               more than 7 days ago, stalest first, skipping any id dispatched in the last 24 h (so an unanswerable
--               row cannot pin the head of the walk). Book ~13k rows = ~55 scripts a week; 12/h covers it with room.
--   No prune: ~12 rows/hour, ~100k a year; a DELETE in the body is held by the MCP apply gate.
-- The script is the V1 read proven on 10-19/10-20 (audit_20261019_i197_scripts, 1,009 scripts, 0 non-200 answers).
-- Revert: SELECT cron.unschedule('rpc-allday-v1-listing-reverify');
--         UPDATE pipeline_cadence_watchlist SET is_active=false WHERE pipeline='allday-v1-listing-reverify';
--         (rows it closed: completed_status IN ('ghosted','vanished','purchased') AND verified_at = completed_at
--          AND source='direct_v1', joined to allday_v1_reverify_requests.ids — reopen only after a chain re-read)

CREATE TABLE IF NOT EXISTS public.allday_v1_reverify_requests (
  request_id     bigint PRIMARY KEY,
  seller_address text NOT NULL,
  ids            bigint[] NOT NULL,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  drained_at     timestamptz,
  http_status    integer,
  outcome        jsonb
);
CREATE INDEX IF NOT EXISTS allday_v1_reverify_requests_undrained
  ON public.allday_v1_reverify_requests (dispatched_at) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS allday_v1_reverify_requests_dispatched
  ON public.allday_v1_reverify_requests (dispatched_at);
ALTER TABLE public.allday_v1_reverify_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allday_v1_reverify_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.allday_v1_reverify_tick(p_max integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_all_day constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_started timestamptz := clock_timestamp();
  v_script text := replace(encode(convert_to($cdc$import NFTStorefront from 0x4eb8a10cb9f87357
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(seller: Address, ids: [UInt64]): {String: String} {
  var out: {String: String} = {}
  let acct = getAccount(seller)
  let sf = acct.capabilities.borrow<&{NFTStorefront.StorefrontPublic}>(NFTStorefront.StorefrontPublicPath)
  if sf == nil {
    out["_storefront"] = "none"
    return out
  }
  let col = acct.capabilities.borrow<&AllDay.Collection>(/public/AllDayNFTCollection)
  for id in ids {
    if let l = sf!.borrowListing(listingResourceID: id) {
      let d = l.getDetails()
      if d.purchased {
        out[id.toString()] = "purchased"
      } else if col == nil {
        out[id.toString()] = "unknown"
      } else if col!.borrowMomentNFT(id: d.nftID) == nil {
        out[id.toString()] = "ghost"
      } else {
        out[id.toString()] = "live"
      }
    } else {
      out[id.toString()] = "gone"
    }
  }
  return out
}$cdc$, 'UTF8'), 'base64'), E'\n', '');
  v_drained int := 0; v_http_err int := 0; v_timeouts int := 0;
  v_live int := 0; v_closed int := 0; v_unknown int := 0; v_no_storefront int := 0;
  v_dispatched int := 0; v_ids_dispatched int := 0;
  v_drain jsonb; v_result jsonb;
  v_err text; r record; v_req bigint;
BEGIN
  BEGIN
    -- 1. drain (no temp tables: every set lives in a variable, bounded by p_max x 250 ids per tick)
    SELECT coalesce(jsonb_agg(jsonb_build_object('request_id', q.request_id, 'status', x.status_code,
                     'content', CASE WHEN x.status_code = 200 THEN x.content END)), '[]'::jsonb)
      INTO v_drain
      FROM public.allday_v1_reverify_requests q
      LEFT JOIN net._http_response x ON x.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (x.id IS NOT NULL OR q.dispatched_at < now() - interval '10 minutes');

    SELECT coalesce(jsonb_agg(jsonb_build_object('request_id', (d->>'request_id')::bigint,
                     'k', e->'key'->>'value', 'st', e->'value'->>'value')), '[]'::jsonb)
      INTO v_result
      FROM jsonb_array_elements(v_drain) d,
           LATERAL jsonb_array_elements(
             convert_from(decode(btrim(btrim(d->>'content'), '"'), 'base64'), 'UTF8')::jsonb -> 'value') e
     WHERE (d->>'status')::int = 200;

    v_drained  := jsonb_array_length(v_drain);
    SELECT count(*) FILTER (WHERE (d->>'status') IS NOT NULL AND (d->>'status')::int <> 200),
           count(*) FILTER (WHERE (d->>'status') IS NULL)
      INTO v_http_err, v_timeouts FROM jsonb_array_elements(v_drain) d;
    SELECT count(*) FILTER (WHERE e->>'st' = 'unknown'), count(*) FILTER (WHERE e->>'k' = '_storefront')
      INTO v_unknown, v_no_storefront FROM jsonb_array_elements(v_result) e;

    UPDATE public.cached_listings_v2 v
       SET verified_at = clock_timestamp()
      FROM jsonb_to_recordset(v_result) AS r2(request_id bigint, k text, st text)
     WHERE r2.st = 'live' AND r2.k ~ '^[0-9]+$'
       AND v.listing_resource_id = r2.k::bigint AND v.source = 'direct_v1'
       AND v.collection_id = c_all_day AND v.completed_at IS NULL;
    GET DIAGNOSTICS v_live = ROW_COUNT;

    UPDATE public.cached_listings_v2 v
       SET completed_at = clock_timestamp(), verified_at = clock_timestamp(),
           completed_status = CASE r2.st WHEN 'ghost' THEN 'ghosted' WHEN 'gone' THEN 'vanished' ELSE 'purchased' END
      FROM jsonb_to_recordset(v_result) AS r2(request_id bigint, k text, st text)
     WHERE r2.st IN ('ghost', 'gone', 'purchased') AND r2.k ~ '^[0-9]+$'
       AND v.listing_resource_id = r2.k::bigint AND v.source = 'direct_v1'
       AND v.collection_id = c_all_day AND v.completed_at IS NULL;
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    UPDATE public.allday_v1_reverify_requests q
       SET drained_at = clock_timestamp(), http_status = (d->>'status')::int,
           outcome = (SELECT jsonb_object_agg(st, n)
                        FROM (SELECT e->>'st' AS st, count(*) AS n FROM jsonb_array_elements(v_result) e
                               WHERE (e->>'request_id')::bigint = q.request_id GROUP BY 1) s)
      FROM jsonb_array_elements(v_drain) d
     WHERE q.request_id = (d->>'request_id')::bigint;

    -- 2. dispatch
    FOR r IN
      WITH recent AS (
        SELECT DISTINCT unnest(ids) AS lid FROM public.allday_v1_reverify_requests
         WHERE dispatched_at > now() - interval '24 hours'
      ), cand AS (
        SELECT c.seller_address, c.listing_resource_id AS lid, c.verified_at
          FROM public.cached_listings_v2 c
         WHERE c.collection_id = c_all_day AND c.source = 'direct_v1' AND c.completed_at IS NULL
           AND (c.verified_at IS NULL OR c.verified_at < now() - interval '7 days')
           AND c.seller_address ~ '^0x[0-9a-f]{16}$'
           AND NOT EXISTS (SELECT 1 FROM recent WHERE recent.lid = c.listing_resource_id)
      ), numbered AS (
        SELECT seller_address, lid, verified_at,
               (row_number() OVER (PARTITION BY seller_address ORDER BY lid) - 1) / 250 AS ch
          FROM cand
      )
      SELECT seller_address, ch, array_agg(lid ORDER BY lid) AS ids,
             min(coalesce(verified_at, '-infinity'::timestamptz)) AS stalest
        FROM numbered
       GROUP BY seller_address, ch
       ORDER BY stalest, seller_address, ch
       LIMIT GREATEST(p_max, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
        body := jsonb_build_object(
          'script', v_script,
          'arguments', jsonb_build_array(
            replace(encode(convert_to(json_build_object('type', 'Address', 'value', r.seller_address)::text, 'UTF8'), 'base64'), E'\n', ''),
            replace(encode(convert_to(json_build_object('type', 'Array', 'value',
              (SELECT json_agg(json_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(r.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 30000);
      INSERT INTO public.allday_v1_reverify_requests (request_id, seller_address, ids)
      VALUES (v_req, r.seller_address, r.ids);
      v_dispatched := v_dispatched + 1;
      v_ids_dispatched := v_ids_dispatched + cardinality(r.ids);
    END LOOP;

  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    -- An unparseable response would otherwise fail every tick from the head of the drain. Retire requests that
    -- have stayed undrained for an hour (one bounded indexed UPDATE; their ids become eligible again after 24 h).
    UPDATE public.allday_v1_reverify_requests SET drained_at = clock_timestamp(), http_status = -1
     WHERE drained_at IS NULL AND dispatched_at < now() - interval '1 hour';
  END;

  PERFORM public.log_pipeline_run('allday-v1-listing-reverify', v_started,
    CASE WHEN v_err IS NULL THEN v_drained END,
    CASE WHEN v_err IS NULL THEN v_live + v_closed END,
    CASE WHEN v_err IS NULL THEN v_unknown + v_no_storefront END,
    v_err IS NULL, v_err, 'nfl_all_day', NULL, NULL,
    jsonb_build_object('drained', v_drained, 'http_errors', v_http_err, 'timeouts', v_timeouts,
                       'verified_live', v_live, 'closed_dead', v_closed, 'unknown', v_unknown,
                       'no_storefront', v_no_storefront, 'dispatched', v_dispatched,
                       'ids_dispatched', v_ids_dispatched, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('drained', v_drained, 'verified_live', v_live, 'closed_dead', v_closed,
                            'dispatched', v_dispatched, 'ids_dispatched', v_ids_dispatched, 'error', v_err);
END
$fn$;
-- anon-exec: revoked (allday_v1_reverify_tick) — new SECDEF writer, pg_cron (postgres) only.
REVOKE EXECUTE ON FUNCTION public.allday_v1_reverify_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allday_v1_reverify_tick(integer) TO postgres, service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('allday-v1-listing-reverify', 150, 'info',
        'pg_cron rpc-allday-v1-listing-reverify, 24 * * * * since 2026-10-20 (#198). Re-verifies open All Day direct_v1 listings on chain (Flow REST scripts via pg_net), closes ghosted/vanished/purchased asks. Silence = V1 dead asks accumulate again (~1 %/month measured 10-20).',
        true, 300)
ON CONFLICT DO NOTHING;

SELECT cron.schedule('rpc-allday-v1-listing-reverify', '24 * * * *', 'SELECT public.allday_v1_reverify_tick(12);');
