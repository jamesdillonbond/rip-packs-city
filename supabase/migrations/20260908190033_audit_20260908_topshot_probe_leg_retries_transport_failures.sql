-- anon-exec: intentional — CREATE OR REPLACE of an existing SECURITY DEFINER pipeline function, same signature (ACLs preserved: anon/authenticated EXECUTE false, service_role true) (topshot_resolve_unmapped_via_atlas)
-- audit_20260908: leg 2's 14-day "already probed" stamp must not be earned by a probe that never
-- reached Atlas.
--
-- WHY, found by the proof run of the migration one before this. Leg 2's first dispatch of 12 probes came
-- back **9 × HTTP 200 and 3 × HTTP 403** — the documented Cloudflare challenge, escalated by the burst.
-- The stamp is written at DISPATCH time (it has to be; the answer does not exist yet), so those 3 nfts
-- were marked probed and would have waited **14 days for a request that never arrived at the upstream**.
-- That is the exact failure shape this repo keeps re-learning: a marker that records the ATTEMPT is read
-- later as if it recorded the OUTCOME. `allday_resolve_unmapped_via_atlas` leg 2 has the same flaw; it is
-- not fixed here because that lane is not in scope and its 25-per-run budget hides the cost.
--
-- ⛔ WHY THE OBVIOUS FIX DOES NOT WORK: matching the failed request back to its nft by its marker is
-- impossible after the fact — on any non-200 `atlas_market_drain()` does
-- `SET error = left(SQLERRM, 300)`, which OVERWRITES the `__nft__<id>` marker with 'atlas 403 (): <!DOCT…'.
-- The nft's identity is gone from the request row. (That is also why the live marker census shows
-- `offset_at = 0` rows whose error is an Atlas 403 body.)
--
-- WHAT. Record the pg_net request id on the parked row at dispatch (`resolution_hint.atlas_probe_req`),
-- and treat the 14-day stamp as binding ONLY while that response is not a recorded failure:
--   eligible again  <=>  the recorded response exists AND (status <> 200 OR timed_out)
-- A transport failure is retried on the very next hourly tick; a genuine absence (200 that simply does
-- not name the nft) keeps its 14 days. If the `net._http_response` row has aged out or has not arrived
-- yet, the predicate falls back to honouring the stamp — conservative in the direction that spends no
-- upstream budget. Cost is one PK lookup per candidate row.
--
-- REVERT: re-apply the body of `audit_20260908_topshot_unmapped_probe_leg`. Rows already carrying
-- `atlas_probe_req` are harmless to that version — it simply ignores the key.

CREATE OR REPLACE FUNCTION public.topshot_resolve_unmapped_via_atlas()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  -- Probe budget per hourly run, against ~110 newly-unseen parked rows a day.
  c_probe_max constant int := 12;
  v_rows      jsonb;
  v_cand      int := 0;
  v_mapped    int := 0;
  v_open      int := 0;
  v_unseen    int := 0;
  v_probed    int := 0;
  v_retried   int := 0;
  v_inflight  int := 0;
  v_err       text;
  r           record;
  v_req       bigint;
BEGIN
  PERFORM set_config('statement_timeout', '60000', true);

  IF NOT pg_try_advisory_xact_lock(hashtext('topshot_resolve_unmapped_via_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    -- ── LEG 1 ────────────────────────────────────────────────────────────────
    -- Every OPEN parked Top Shot nft the firehose has seen with a canonical edition and a real serial.
    SELECT count(*), jsonb_agg(jsonb_build_object('nft_id', x.nft_id, 'edition_external_id', x.external_id, 'serial_number', x.serial_number))
      INTO v_cand, v_rows
      FROM (
        SELECT DISTINCT ON (ev.nft_id) ev.nft_id, e.external_id, ev.serial_number
          FROM public.topshot_atlas_market_events ev
          JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
          JOIN public.editions e ON e.id = m.rpc_edition_id AND e.collection_id = v_ts
         WHERE ev.product = 'nba'
           AND ev.nft_id ~ '^[0-9]+$'
           AND ev.serial_number > 0
           AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
           AND EXISTS (SELECT 1 FROM public.unmapped_sales us
                        WHERE us.collection_id = v_ts AND us.resolved_at IS NULL AND us.nft_id = ev.nft_id)
           AND NOT EXISTS (SELECT 1 FROM public.nft_edition_map nem
                            WHERE nem.collection_id = v_ts AND nem.nft_id = ev.nft_id)
         ORDER BY ev.nft_id, ev.last_seen_at DESC
      ) x;

    IF v_rows IS NOT NULL THEN
      v_mapped := public.upsert_nft_edition_map_batch(v_ts, v_rows);
    END IF;

    -- How many of this run's candidates are re-tries of a probe that never reached Atlas? Reported so a
    -- persistent upstream refusal is visible as a number rather than as a silently stalled lane.
    SELECT count(*) INTO v_retried
      FROM public.unmapped_sales us
     WHERE us.collection_id = v_ts AND us.resolved_at IS NULL
       AND us.resolution_hint ? 'atlas_probe_req'
       AND EXISTS (SELECT 1 FROM net._http_response rr
                    WHERE rr.id = (us.resolution_hint->>'atlas_probe_req')::bigint
                      AND (rr.status_code IS DISTINCT FROM 200 OR rr.timed_out));

    -- ── LEG 2 ────────────────────────────────────────────────────────────────
    SELECT count(*) INTO v_inflight
      FROM public.topshot_atlas_market_requests
     WHERE product = 'nba' AND offset_at = -6 AND drained_at IS NULL
       AND dispatched_at > now() - interval '10 minutes';

    FOR r IN
      SELECT us.nft_id, max(us.sold_at) AS newest_sale
        FROM public.unmapped_sales us
       WHERE us.collection_id = v_ts AND us.resolved_at IS NULL
         AND COALESCE(us.price_usd, 0) > 0
         AND us.nft_id ~ '^[0-9]{1,12}$'
         -- The 14-day stamp binds only while the probe it records is not a KNOWN transport failure.
         AND NOT (
               us.resolution_hint ? 'atlas_probe_at'
               AND (us.resolution_hint->>'atlas_probe_at')::timestamptz > now() - interval '14 days'
               AND NOT EXISTS (SELECT 1 FROM net._http_response rr
                                WHERE rr.id = (us.resolution_hint->>'atlas_probe_req')::bigint
                                  AND (rr.status_code IS DISTINCT FROM 200 OR rr.timed_out))
             )
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                          WHERE ev.product = 'nba' AND ev.nft_id = us.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.nft_edition_map nem
                          WHERE nem.collection_id = v_ts AND nem.nft_id = us.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q
                          WHERE q.error = '__nft__' || us.nft_id AND q.drained_at IS NULL)
       GROUP BY us.nft_id
       ORDER BY max(us.sold_at) DESC
       LIMIT GREATEST(c_probe_max - v_inflight, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nba', 'nftId', r.nft_id, 'limit', 20),
        headers := public.atlas_market_headers('nba'),
        timeout_milliseconds := 15000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
      VALUES (v_req, 'nba', -6, '__nft__' || r.nft_id);
      UPDATE public.unmapped_sales
         SET resolution_hint = COALESCE(resolution_hint, '{}'::jsonb)
               || jsonb_build_object('atlas_probe_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                                     'atlas_probe_req', v_req)
       WHERE collection_id = v_ts AND resolved_at IS NULL AND nft_id = r.nft_id;
      v_probed := v_probed + 1;
    END LOOP;

    SELECT count(*),
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                                                WHERE ev.product = 'nba' AND ev.nft_id = us.nft_id))
      INTO v_open, v_unseen
      FROM public.unmapped_sales us
     WHERE us.collection_id = v_ts AND us.resolved_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-unmapped-atlas-resolver', v_started, v_cand, v_mapped, v_probed,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('mapped_from_events', v_mapped, 'candidates', v_cand,
                       'probes_dispatched', v_probed, 'probes_inflight_before', v_inflight,
                       'probes_retrying_transport_failure', v_retried,
                       'open_unresolved', v_open, 'open_unseen_by_firehose', v_unseen, 'via', 'pg_cron',
                       'note', 'leg 1 maps what the firehose saw; leg 2 probes what it never named (marker offset_at=-6) and re-probes any nft whose recorded probe response was not a 200; promote_unmapped_sales (jobid 474, :54) writes them into sales',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('mapped_from_events', v_mapped, 'candidates', v_cand,
                            'probes_dispatched', v_probed,
                            'probes_retrying_transport_failure', v_retried,
                            'open_unresolved', v_open,
                            'open_unseen_by_firehose', v_unseen, 'error', v_err);
END $$;