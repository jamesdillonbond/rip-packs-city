-- anon-exec: intentional — CREATE OR REPLACE of an existing SECURITY DEFINER pipeline function, same signature (ACLs preserved: anon/authenticated EXECUTE false, service_role true) (topshot_resolve_unmapped_via_atlas)
-- audit_20260908: leg 2 for the parked-sale resolver — probe Atlas for the parked Top Shot nfts the
-- firehose has never named. Same shape as `allday_resolve_unmapped_via_atlas`'s leg 2 (jobid 464).
--
-- WHY, and it is the falsifier this lane shipped with. `20260908141132` mapped 337 of 355 open parked
-- rows from events the firehose already held and left 18 it had never seen, with the watch written into
-- the watchlist row: "if open_unseen_by_firehose climbs, a probe lane is the next decision." Measured
-- 2026-09-08 18:5xZ, four hourly ticks later: **18 -> 26 -> 30 -> 32 -> 36**, ~4.5/h ≈ 110/day, and the
-- leg-1 hand-off is otherwise working perfectly (15:50 mapped 12 -> 15:54 promoted 12; 16:50 9 -> 10;
-- 17:50 4 -> 4; cross-source duplicate falsifier still 0). So the climb is not lag: of the 36, **17 are
-- already older than 6 h** (oldest 02:44Z) and there is NO free local path for any of them — 0 in
-- `moments`, 0 in `wallet_moments_cache`, 0 in `topshot_ownership`, 0 in `nft_edition_map`. All 36 are
-- numeric nft ids, `source='onchain'`, marketplace `topshot`. Left alone they accumulate ~110 real sales
-- a day, each with a tx hash and an on-chain price, that no lane can ever resolve.
--
-- WHAT. Leg 2 asks Atlas for the nft's own transaction history
-- (`SearchMarketplaceTransactions {product:'nba', nftId, limit:20}`); `atlas_market_drain()` upserts the
-- answer through `atlas_market_upsert_events` like any other response — it is fully generic over the
-- request table and, since 2026-09-07, never re-pages a negative `offset_at`. The events it writes carry
-- `atlas_edition_id` + `serial_number`, so LEG 1 OF THIS SAME FUNCTION maps them on the next hourly tick
-- and jobid 474 promotes them four minutes later.
--
-- MARKER: `offset_at = -6`, `error = '__nft__' || nft_id`. Read live 2026-09-08 18:5xZ, the nba markers
-- in use are -1 (`__probe__`), -3 (`__verify__`), -4 and -5 (`__edition__`); nfl uses -2 for its own
-- `__nft__` probes. -6 is free and is NOT shared with nfl's leg 2.
--
-- BUDGET (the reason this was not shipped with the lane): the Atlas host is Cloudflare-challenged at a
-- ~5-15% base rate and escalates after a burst. Cap is 12 per hourly run = 288/day against an inflow of
-- ~110/day, so the 36-row backlog clears on the third tick and the lane then idles at ~5 probes/hour —
-- about +0.08 req/min on an estate running ~5-6/min. Gentler in aggregate than All Day's leg 2, which
-- bursts up to 10 every 5 minutes. In-flight probes are subtracted from the cap so a slow drain cannot
-- stack dispatches, and a probed nft is not re-probed for 14 days (`resolution_hint.atlas_probe_at`).
--
-- NO NEW DUPLICATE WINDOW: whichever writer reaches the sale first is already guarded. If the promoter
-- gets there first it inserts with the tx hash and `sync_sales_from_atlas`'s ±10 min per-nft dedupe skips
-- it; if the Atlas lane gets there first it marks the open parked row resolved onto its own row
-- (`20260908030456`). Both orders were proven live today; the falsifier reads 0.
--
-- REVERT (a stranger can run this): re-apply the body of `20260908141132` (leg 1 only). The cron entry,
-- the watchlist row and the grants are unchanged by this migration, so nothing else needs undoing.
-- To find what leg 2 dispatched:
--   SELECT * FROM public.topshot_atlas_market_requests WHERE product='nba' AND offset_at=-6;

CREATE OR REPLACE FUNCTION public.topshot_resolve_unmapped_via_atlas()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  -- Probe budget per hourly run, against ~110 newly-unseen parked rows a day. See BUDGET above.
  c_probe_max constant int := 12;
  v_rows      jsonb;
  v_cand      int := 0;
  v_mapped    int := 0;
  v_open      int := 0;
  v_unseen    int := 0;
  v_probed    int := 0;
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

    -- ── LEG 2 (2026-09-08) ───────────────────────────────────────────────────
    -- Ask Atlas for the parked nfts nothing has ever seen. Newest sale first, in-flight subtracted from
    -- the cap, one probe per nft per 14 days.
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
         AND NOT (us.resolution_hint ? 'atlas_probe_at'
                  AND (us.resolution_hint->>'atlas_probe_at')::timestamptz > now() - interval '14 days')
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
               || jsonb_build_object('atlas_probe_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
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
                       'open_unresolved', v_open, 'open_unseen_by_firehose', v_unseen, 'via', 'pg_cron',
                       'note', 'leg 1 maps what the firehose saw; leg 2 probes what it never named (marker offset_at=-6); promote_unmapped_sales (jobid 474, :54) writes them into sales',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('mapped_from_events', v_mapped, 'candidates', v_cand,
                            'probes_dispatched', v_probed, 'open_unresolved', v_open,
                            'open_unseen_by_firehose', v_unseen, 'error', v_err);
END $$;

UPDATE public.pipeline_cadence_watchlist
   SET notes = 'pg_cron rpc-topshot-unmapped-atlas-resolver hourly at :50 since 2026-09-08 (migrations audit_20260908_topshot_unmapped_atlas_resolver + ..._probe_leg). LEG 1 writes nft_edition_map rows for OPEN parked Top Shot sales from topshot_atlas_market_events (newest event per nft, edition via topshot_atlas_edition_map, canonical editions only, never overwrites). LEG 2 (2026-09-08) probes Atlas for parked nfts the firehose has NEVER named, max 12 per run minus in-flight, marker offset_at=-6 / error=__nft__<id>, one probe per nft per 14 days; the drain upserts the answer and leg 1 maps it on the next tick. rows_written = mapped_from_events, rows_skipped = probes_dispatched (0 of either is normal when nothing new is parked). Watch extra.open_unseen_by_firehose: it should now FALL toward 0 and stay there — if it climbs again while probes_dispatched is non-zero, the probes are being answered without the nft (a real Atlas gap), not a budget problem.'
 WHERE pipeline = 'topshot-unmapped-atlas-resolver';