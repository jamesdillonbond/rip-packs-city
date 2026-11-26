-- audit_20261125_pack_nft_identity_targeted_enqueue_per_collection
--
-- 2026-11-25 (Claude Code cloud; Trevor: "work through everything you can in this thread, leaving nothing unresolved").
-- WHY. 11-24 review finding 5 (latent): dispatch_pack_nft_identity's TARGETED path (p_pack_nft_ids, called by
-- resolve-allday-rip-dist-api and the not_found retry jobs) picked the collection for each id with a LIMIT 1 over
-- pack_rips then pack_purchases across Top Shot AND All Day. Pack ids are unique only within a collection, so an id
-- present in both would be resolved against one product and never the other. Measured 11-25: 0 shared ids
-- (398,395 Top Shot vs 2,901 All Day purchase ids) — nothing is mis-routed today.
-- WHAT. The targeted INSERT enqueues one row per (collection, id) the pack's own rip/purchase rows prove. Everything
-- else — top-up path, skipped count, 30-request cap, pop/dispatch loop, return shape — is byte-identical.
-- Signature, SECURITY DEFINER, search_path and ACL unchanged. Base = live body (md5 73425dd9a8496a9caed667400ee2fc13), asserted below.
--
-- anon-exec: unchanged (dispatch_pack_nft_identity) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the dispatch_pack_nft_identity block of 20261119050000_audit_20261118_pack_identity_and_pulls_off_studio_onto_atlas.sql (or the latest migration that defines it).

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.dispatch_pack_nft_identity(integer,integer,text[])'::regprocedure)
     <> '73425dd9a8496a9caed667400ee2fc13' THEN
    RAISE EXCEPTION 'dispatch_pack_nft_identity live body drifted; re-read before replacing';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_pack_nft_identity(p_batches integer DEFAULT 3, p_batch_size integer DEFAULT 100, p_pack_nft_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
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
    -- 2026-11-25: one queue row per (collection, id) the pack's OWN rows prove, never a LIMIT 1 guess
    -- across collections. Pack ids are unique only within a collection (11-24 review finding 5); a
    -- shared id was queued under whichever collection's row came first. 0 shared ids measured 11-25
    -- (398,395 Top Shot vs 2,901 All Day purchase ids), so this changes no row today.
    INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
    SELECT k.collection_id, k.id, now()
    FROM (
      SELECT DISTINCT u.id, rp.collection_id
        FROM unnest(p_pack_nft_ids) AS u(id)
        JOIN public.pack_rips rp ON rp.pack_nft_id = u.id AND rp.collection_id IN (v_ts, v_ad)
      UNION
      SELECT DISTINCT u.id, pp.collection_id
        FROM unnest(p_pack_nft_ids) AS u(id)
        JOIN public.pack_purchases pp ON pp.pack_nft_id = u.id AND pp.collection_id IN (v_ts, v_ad)
    ) k
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
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
