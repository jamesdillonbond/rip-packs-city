-- audit_20261118_atlas_market_feed_adds_golazos_and_pinnacle
--
-- 2026-11-18 (PT, ~9:05 PM; Claude Code cloud; Trevor: "Do all of them") -- item 3 of the Atlas port, #218.
-- (1) atlas_market_dispatch walks SearchMarketplaceTransactions for 'laliga' and 'disney' too. Measured
--     11-18: both answer 200 with live listings + sales (a Pinnacle sale completed 7:13 PM PT). The 22
--     readers of topshot_atlas_market_events were read one by one: 21 filter product = 'nba' (or their
--     own product); the 22nd, check_topshot_parallel_sales_on_base, matched on nft_id alone, so (2) adds
--     a.product = 'nba' there. The upsert key is the event uuid, so products cannot overwrite each other.
--     Cost: two more Atlas calls per 2-min tick (one page in flight per product, as before).
-- (2) check_topshot_parallel_sales_on_base: LIVE BODY DIFFERS FROM ITS NEWEST FILE (live md5 1f498850...,
--     20261115011709's body 30ef1fe9...), so it is spliced in place against the live body, md5-guarded,
--     rather than re-created from a file that is not what runs.
-- (3) dispatch_pack_nft_identity: `skipped_no_collection` counted ids already queued or identified too.
--
-- REVERT: atlas_market_dispatch from 20260906214103_audit_20260906_allday_unmapped_sales_resolve_via_atlas.sql;
-- dispatch_pack_nft_identity from 20261119050000_audit_20261118_pack_identity_and_pulls_off_studio_onto_atlas.sql;
-- check_topshot_parallel_sales_on_base: the DO block below with the replace() pair swapped and the md5 guard
-- set to this migration's output md5.
-- anon-exec: unchanged (atlas_market_dispatch) — CREATE OR REPLACE keeps the ACL
-- anon-exec: unchanged (dispatch_pack_nft_identity) — CREATE OR REPLACE keeps the ACL
-- anon-exec: unchanged (check_topshot_parallel_sales_on_base) — spliced in place; ACL untouched

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.atlas_market_dispatch()'::regprocedure) <> '8a9b147273b55b07a7de6a8c602add0d' THEN
    RAISE EXCEPTION 'atlas_market_dispatch drifted; re-derive';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'dispatch_pack_nft_identity' AND pronamespace = 'public'::regnamespace) <> 'a72d765492c65e6003b23233f60423b2' THEN
    RAISE EXCEPTION 'dispatch_pack_nft_identity drifted; re-derive';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.atlas_market_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_req bigint; v_n int := 0; p text; v_offset int;
BEGIN
  -- 2026-11-18 (#218): Golazos ('laliga') and Pinnacle ('disney') added. Studio GraphQL is HTTP 530 and
  -- their listings/sales had no other Dapper feed; every reader of topshot_atlas_market_events filters on
  -- product (checked 11-18), and the conflict key is the event uuid, so the new rows cannot mix in.
  FOREACH p IN ARRAY ARRAY['nba','nfl','laliga','disney'] LOOP
    -- One FIREHOSE page in flight per product (offset_at >= 0). NFT probes
    -- (offset_at = -2, the All Day resolver) and session probes (-1) do not count.
    -- A request older than 10 min with no response is abandoned by the drain.
    IF EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q
                WHERE q.product = p AND q.offset_at >= 0 AND q.drained_at IS NULL
                  AND q.dispatched_at > now() - interval '10 minutes') THEN
      CONTINUE;
    END IF;
    SELECT COALESCE((SELECT q.offset_at FROM public.topshot_atlas_market_requests q WHERE q.product = p AND q.error = '__next_offset__' ORDER BY q.dispatched_at DESC LIMIT 1), 0) INTO v_offset;
    DELETE FROM public.topshot_atlas_market_requests WHERE product = p AND error = '__next_offset__';
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', p, 'limit', 200, 'offset', v_offset),
      headers := public.atlas_market_headers(p),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at) VALUES (v_req, p, v_offset);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_pack_nft_identity(
  p_batches integer DEFAULT 3,
  p_batch_size integer DEFAULT 100,
  p_pack_nft_ids text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
-- 2026-11-18 (#218): ported off Dapper's Studio GraphQL (HTTP 530 since 11-17) to Atlas
-- PackService/ResolvePackDistribution, which answers ONE pack per call. Two changes follow:
--  * a targeted call (p_pack_nft_ids, from the not_found retry jobs: up to 200/h + 300/day)
--    no longer sends directly -- it ENQUEUES, so every id drains at the lane's rate;
--  * each call sends at most 30 requests, whatever p_batches x p_batch_size asks for. Cloudflare
--    in front of Atlas escalates from a ~5-15 % challenge rate to 100 % after a burst.
DECLARE
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
  v_cap     int := least(30, greatest(0, least(coalesce(p_batches, 3), 10)) * greatest(1, least(coalesce(p_batch_size, 100), 100)));
  v_req     bigint;
  v_prod    text;
  v_sent    int := 0;
  v_topped_up int := 0;
  v_enqueued int := 0;
  v_skipped int := 0;
  r record;
BEGIN
  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  IF p_pack_nft_ids IS NULL THEN
    -- Top-up: only the last day of the two partial indexes, index-ordered, so
    -- the walk is a few hundred rows however large the backlog is.
    INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
    SELECT c.collection_id, c.pack_nft_id, max(c.at)
    FROM (
      SELECT pp.collection_id, pp.pack_nft_id, pp.sealed_at AS at
      FROM public.pack_purchases pp
      WHERE pp.pack_dist_id IS NULL AND pp.collection_id IN (v_ts, v_ad)
        AND pp.sealed_at > now() - interval '1 day'
      UNION ALL
      SELECT r2.collection_id, r2.pack_nft_id, r2.sealed_at
      FROM public.pack_rips r2
      WHERE r2.dist_id IS NULL AND r2.collection_id IN (v_ts, v_ad)
        AND r2.sealed_at > now() - interval '1 day'
    ) c
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                       WHERE pi.collection_id = c.collection_id AND pi.pack_nft_id = c.pack_nft_id)
    GROUP BY c.collection_id, c.pack_nft_id
    ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    GET DIAGNOSTICS v_topped_up = ROW_COUNT;
  ELSE
    -- Targeted: enqueue. Atlas needs the product, so the collection comes from the pack's own
    -- rip or purchase row (both indexed on pack_nft_id); an id in neither cannot be asked about.
    INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
    SELECT k.collection_id, k.id, now()
    FROM (
      SELECT DISTINCT u.id,
             coalesce((SELECT rp.collection_id FROM public.pack_rips rp
                        WHERE rp.pack_nft_id = u.id AND rp.collection_id IN (v_ts, v_ad) LIMIT 1),
                      (SELECT pp.collection_id FROM public.pack_purchases pp
                        WHERE pp.pack_nft_id = u.id AND pp.collection_id IN (v_ts, v_ad) LIMIT 1)) AS collection_id
      FROM unnest(p_pack_nft_ids) AS u(id)
    ) k
    WHERE k.collection_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                       WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.id)
    ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    GET DIAGNOSTICS v_enqueued = ROW_COUNT;
    -- Only ids with NO rip or purchase row in Top Shot / All Day (Atlas needs the product). An id
    -- already queued or already identified is not "skipped": the 11-18 first run counted 9 queued
    -- All Day rips here, which read as 9 packs with no collection.
    v_skipped := (SELECT count(*) FROM (SELECT DISTINCT u.id FROM unnest(p_pack_nft_ids) AS u(id)) k
                   WHERE NOT EXISTS (SELECT 1 FROM public.pack_rips rp WHERE rp.pack_nft_id = k.id AND rp.collection_id IN (v_ts, v_ad))
                     AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp WHERE pp.pack_nft_id = k.id AND pp.collection_id IN (v_ts, v_ad)));
  END IF;

  -- Pop newest-first. The ids leave the queue here; a failed or expired
  -- request puts them back (collect), an answered one lands in identity.
  FOR r IN
    WITH pick AS (
      SELECT collection_id, pack_nft_id
      FROM public.pack_nft_identity_queue
      ORDER BY last_seen_at DESC
      LIMIT v_cap
      FOR UPDATE SKIP LOCKED
    ), popped AS (
      DELETE FROM public.pack_nft_identity_queue q
      USING pick
      WHERE q.collection_id = pick.collection_id AND q.pack_nft_id = pick.pack_nft_id
      RETURNING q.collection_id, q.pack_nft_id
    )
    SELECT DISTINCT collection_id, pack_nft_id FROM popped
  LOOP
    v_prod := CASE r.collection_id WHEN v_ad THEN 'nfl' WHEN v_gz THEN 'laliga' WHEN v_ts THEN 'nba' END;
    CONTINUE WHEN v_prod IS NULL;
    v_req := public.atlas_pack_dispatch('resolve', v_prod, NULL, NULL, ARRAY[r.pack_nft_id]);
    INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, product)
    VALUES (v_req, ARRAY[r.pack_nft_id], 1, v_prod);
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'dispatched', v_sent, 'ids_sent', v_sent,
                            'topped_up', v_topped_up, 'enqueued', v_enqueued, 'skipped_no_collection', v_skipped,
                            'queue_depth', (SELECT count(*) FROM public.pack_nft_identity_queue),
                            'pending_requests', (SELECT count(*) FROM public.pack_nft_identity_requests WHERE collected_at IS NULL));
END;
$function$;

DO $splice$
DECLARE
  v_oid oid := 'public.check_topshot_parallel_sales_on_base(integer)'::regprocedure;
  d text;
  o text := $o$FROM topshot_atlas_market_events a WHERE a.nft_id = s.nft_id AND$o$;
  n text := $n$FROM topshot_atlas_market_events a WHERE a.product = 'nba' AND a.nft_id = s.nft_id AND$n$;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_oid) <> '1f498850a8a764011056641dba7746ec' THEN
    RAISE EXCEPTION 'check_topshot_parallel_sales_on_base drifted (md5 %); re-derive', (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_oid);
  END IF;
  d := pg_get_functiondef(v_oid);
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 1 THEN
    RAISE EXCEPTION 'check_topshot_parallel_sales_on_base: anchor not found exactly once';
  END IF;
  EXECUTE replace(d, o, n);
END
$splice$;
