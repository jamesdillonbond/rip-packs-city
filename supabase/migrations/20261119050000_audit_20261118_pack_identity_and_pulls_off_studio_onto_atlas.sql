-- audit_20261118_pack_identity_and_pulls_off_studio_onto_atlas
--
-- 2026-11-18 (PT, evening; Claude Code cloud; Trevor: "Do all of them") -- #218.
-- Dapper's Studio GraphQL (api.production.studio-platform.dapperlabs.com) has answered HTTP 530 /
-- Cloudflare "error code: 1033" since ~4:23 PM PT 11-17. Dapper's own sites moved to Atlas
-- (api.production.atlas.dapperlabs.com); nflallday.com / nbatopshot.com no longer name Studio.
-- This moves the pack-identity and wallet-pack-pulls lanes onto Atlas's public PackService /
-- NFTService, measured from the DB the same evening:
--   * PackService/ResolvePackDistribution {product, packId} -> dist id + title + tier + image.
--     4 of 4 known Golazos/Pinnacle packs returned our recorded dist (299, 326, 6361, 8742); a
--     Top Shot pack returned 8422 / "Rookie Rumble: Chance Hit" / common = our row. Unknown pack
--     -> HTTP 404 {"code":"not_found"}. It does NOT give status or owner.
--   * PackService/GetPacksByOwner {product, owner, limit, offset} -> {id, distributionId,
--     ownerAddress, status PACK_NFT_STATUS_*, nfts[]} with pagination; Atlas clamps limit at 200.
--     All Day nfts are real moment ids; Top Shot nfts are ALL "0" (and NFTService.packNftId is "0"
--     for 50 of 50 Top Shot moments), so Atlas cannot name Top Shot pulls at all.
--   * NFTService/GetNFTs {product, nftIds} -> {id, editionId, serialNumber}; All Day 5840678 ->
--     edition 2387, the same answer Studio gave (pack_open_pulls row resolved_via studio_api).
-- PackService/GetPack is NOT on the public path (404).
--
-- HOW (the collectors' write logic is unchanged):
--   * atlas_pack_to_studio() translates an Atlas response into the Studio searchPackNft /
--     searchAllDayNft shape the collectors already parse. Request rows gain `product`; NULL =
--     a Studio-era row, parsed exactly as before.
--   * dispatch_pack_nft_identity: one ResolvePackDistribution per pack, AT MOST 30 a call;
--     targeted ids (the not_found retry jobs) are ENQUEUED instead of sent in a burst.
--   * Wallet walks go product by product (sync: nba -> nfl -> laliga; pulls: nfl -> laliga) with
--     an offset cursor; page caps rescaled for 200-pack pages. A Studio-era walk with a next page
--     ends with a stated reason (its cursor is not an offset) and the next sweep restarts it.
--   * Identity rows from Atlas: source 'atlas_pack_service'; a NULL status/owner never overwrites
--     a recorded one. Pulls named by GetNFTs: resolved_via 'atlas_api'.
--
-- REVERT: re-apply each function body from its base file (identical to production before this,
-- md5-checked below):
--   dispatch_pack_nft_identity  20260919031500_audit_20260918_wallet_packs_transferred_status_and_identity_lane_covers_rips.sql
--   collect_pack_nft_identity   20261118055831_audit_20261117_pack_identity_requeue_collapses_bought_and_ripped_duplicates.sql
--   request_wallet_pack_sync    20260919053000_audit_20260918_wallet_pack_sync_one_request_per_wallet_and_hourly_freshness.sql
--   request_wallet_pack_pulls   20261020030627_audit_20261019_a_top_shot_pack_dapper_left_revealed_was_opened.sql
--   collect_wallet_pack_pulls   20261020041933_audit_20261019_a_revealed_box_never_records_a_pack_a_third_party_withdrew.sql
--   run_pack_nft_identity_lane  20260919021500_audit_20260918_pack_nft_identity_lane_names_sealed_packs_from_dapper_search_pack_nft.sql
-- then DROP FUNCTION public.atlas_pack_to_studio(text,integer,text,text[]), public.atlas_pack_dispatch(text,text,text,bigint,text[]),
-- public.atlas_next_pack_product(text,text), public.atlas_moment_token_prefix(text), public.atlas_pack_type_name(text);
-- the two `product` columns can stay (NULL = Studio-era row).

DO $guard$
DECLARE
  want jsonb := '{"dispatch_pack_nft_identity":"f4ba169846f4f3286ba234ec09d613b9","collect_pack_nft_identity":"51a46709aafd22ce1cc9dd63982c036a","request_wallet_pack_sync":"1758a45993d8fb5c7524dfdf909365c2","request_wallet_pack_pulls":"1feff297b552a9fa16fae4531ce34ecc","collect_wallet_pack_pulls":"7ef79c278904d4e2e31b4812250a5868","run_pack_nft_identity_lane":"640e7fe236de213851b6340949623695"}';
  k text; got text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(want) LOOP
    SELECT md5(prosrc) INTO got FROM pg_proc WHERE proname = k AND pronamespace = 'public'::regnamespace;
    IF got IS DISTINCT FROM want->>k THEN
      RAISE EXCEPTION '% drifted (md5 %, expected %); re-derive before replacing', k, got, want->>k;
    END IF;
  END LOOP;
END
$guard$;

ALTER TABLE public.pack_nft_identity_requests ADD COLUMN IF NOT EXISTS product text;
ALTER TABLE public.pack_pull_requests ADD COLUMN IF NOT EXISTS product text;

CREATE OR REPLACE FUNCTION public.atlas_moment_token_prefix(p_product text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT CASE p_product
           WHEN 'nba'    THEN 'A.0b2a3299cc857e29.TopShot.'
           WHEN 'nfl'    THEN 'A.e4cf4bdc1751c65d.AllDay.'
           WHEN 'laliga' THEN 'A.87ca73a41bb50ad5.Golazos.'
         END
$f$;

-- The product a wallet walk moves to after p_product's pages run out (NULL = done).
-- 'sync' (pack_wallet_sync: every pack a wallet holds, for identity): nba -> nfl -> laliga.
-- 'pulls' (pack_open_pulls): nfl -> laliga. Top Shot is skipped there because Atlas
-- returns "0" for every Top Shot pulled-moment id (measured 2026-11-18: 50 of 50).
CREATE OR REPLACE FUNCTION public.atlas_next_pack_product(p_lane text, p_product text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT CASE
           WHEN p_product IS NULL THEN NULL
           WHEN p_lane = 'sync'  AND p_product = 'nba' THEN 'nfl'
           WHEN p_lane = 'sync'  AND p_product = 'nfl' THEN 'laliga'
           WHEN p_lane = 'pulls' AND p_product = 'nfl' THEN 'laliga'
         END
$f$;

-- One Atlas PackService / NFTService call through pg_net. Returns the request id.
--   'resolve' : PackService/ResolvePackDistribution {packId}           (one pack)
--   'owner'   : PackService/GetPacksByOwner {owner, limit 200, offset}  (Atlas clamps limit at 200)
--   'nfts'    : NFTService/GetNFTs {nftIds}                              (batch)
CREATE OR REPLACE FUNCTION public.atlas_pack_dispatch(p_kind text, p_product text, p_wallet text, p_offset bigint, p_ids text[])
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public', 'net', 'pg_temp' AS $f$
DECLARE
  v_base constant text := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.';
  v_url text;
  v_body jsonb;
BEGIN
  IF p_product NOT IN ('nba', 'nfl', 'laliga', 'disney') THEN
    RAISE EXCEPTION 'atlas_pack_dispatch: unknown product %', p_product;
  END IF;
  IF p_kind = 'resolve' THEN
    IF p_ids IS NULL OR cardinality(p_ids) <> 1 THEN RAISE EXCEPTION 'atlas_pack_dispatch resolve: exactly one id'; END IF;
    v_url := v_base || 'PackService/ResolvePackDistribution';
    v_body := jsonb_build_object('product', p_product, 'packId', p_ids[1]);
  ELSIF p_kind = 'owner' THEN
    IF p_wallet !~ '^0x[0-9a-f]{16}$' THEN RAISE EXCEPTION 'atlas_pack_dispatch owner: not a Flow address'; END IF;
    v_url := v_base || 'PackService/GetPacksByOwner';
    v_body := jsonb_build_object('product', p_product, 'owner', substr(p_wallet, 3), 'limit', 200, 'offset', coalesce(p_offset, 0));
  ELSIF p_kind = 'nfts' THEN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'atlas_pack_dispatch nfts: no ids'; END IF;
    v_url := v_base || 'NFTService/GetNFTs';
    v_body := jsonb_build_object('product', p_product, 'nftIds', to_jsonb(p_ids));
  ELSE
    RAISE EXCEPTION 'atlas_pack_dispatch: unknown kind %', p_kind;
  END IF;
  RETURN net.http_post(url := v_url, body := v_body, headers := public.atlas_market_headers(p_product),
                       timeout_milliseconds := 20000);
END
$f$;

CREATE OR REPLACE FUNCTION public.atlas_pack_type_name(p_product text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT CASE p_product
           WHEN 'nba'    THEN 'A.0b2a3299cc857e29.PackNFT.NFT'
           WHEN 'nfl'    THEN 'A.e4cf4bdc1751c65d.PackNFT.NFT'
           WHEN 'laliga' THEN 'A.87ca73a41bb50ad5.PackNFT.NFT'
           WHEN 'disney' THEN 'A.edf9df96c92f4595.PackNFT.NFT'
         END
$f$;

-- Translate one Atlas PackService response into the Studio searchPackNft shape the
-- collectors already parse. Returns NULL when the response is not decodable, so the
-- collector's existing "undecodable" branch handles it. A 404 not_found is a valid
-- answer ("no such pack") and becomes an empty edge list with HTTP 200 semantics.
-- ⚠ Atlas returns "0" for every pulled moment id of a Top Shot (nba) pack: those
-- are UNKNOWN, never moment 0, so they are dropped here.
CREATE OR REPLACE FUNCTION public.atlas_pack_to_studio(p_product text, p_status integer, p_content text, p_ids text[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  j jsonb;
  v_type text := public.atlas_pack_type_name(p_product);
  v_edges jsonb;
  v_next text;
  v_more boolean;
BEGIN
  IF p_status = 404 AND p_content LIKE '%"not_found"%' THEN
    RETURN jsonb_build_object('data', jsonb_build_object('searchPackNft', jsonb_build_object(
      'edges', '[]'::jsonb, 'pageInfo', jsonb_build_object('hasNextPage', false, 'endCursor', NULL))));
  END IF;
  IF p_status IS DISTINCT FROM 200 THEN
    RETURN NULL;
  END IF;
  BEGIN
    j := p_content::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF j ? 'distributionId' THEN  -- ResolvePackDistribution: one pack, the one we asked for
    IF p_ids IS NULL OR cardinality(p_ids) <> 1 THEN RETURN NULL; END IF;
    v_edges := jsonb_build_array(jsonb_build_object('node', jsonb_build_object(
      'id', p_ids[1],
      'dist_id', NULLIF(j->>'distributionId', ''),
      'status', NULL,
      'owner_address', NULL,
      'type_name', v_type,
      'distribution', jsonb_build_object(
        'title', j->'distribution'->>'title',
        'tier', j->'distribution'->>'tier',
        'image_urls', CASE WHEN j->'distribution'->>'imageUrl' IS NULL THEN '[]'::jsonb
                           ELSE jsonb_build_array(j->'distribution'->>'imageUrl') END))));
    v_more := false;
    v_next := NULL;
  ELSIF jsonb_typeof(j->'nfts') = 'array' THEN  -- NFTService/GetNFTs: id -> edition + serial
    SELECT coalesce(jsonb_agg(jsonb_build_object('node', jsonb_build_object(
             'id', n->>'id',
             'serial_number', n->>'serialNumber',
             'edition', jsonb_build_object('id', n->>'editionId')))), '[]'::jsonb)
      INTO v_edges
      FROM jsonb_array_elements(j->'nfts') n
     WHERE n->>'id' IS NOT NULL AND NULLIF(n->>'editionId', '0') IS NOT NULL;
    -- Same key the collector already reads for the All Day / Golazos edition lookup.
    RETURN jsonb_build_object('data', jsonb_build_object('searchAllDayNft', jsonb_build_object('edges', v_edges)));
  ELSIF jsonb_typeof(j->'packs') = 'array' THEN  -- GetPacksByOwner: one page
    SELECT coalesce(jsonb_agg(jsonb_build_object('node', jsonb_build_object(
             'id', p->>'id',
             'dist_id', NULLIF(p->>'distributionId', ''),
             'status', CASE WHEN p->>'status' IS NULL OR p->>'status' ~ 'UNSPECIFIED' THEN 'unknown'
                            ELSE initcap(lower(regexp_replace(p->>'status', '^PACK_NFT_STATUS_', ''))) END,
             'owner_address', p->>'ownerAddress',
             'type_name', v_type,
             -- Studio sent nfts as ONE comma-separated string of "A.<addr>.<Contract>.<id>"
             -- tokens and the pulls collector parses exactly that. Atlas sends bare ids, so
             -- each becomes a token of the pack's OWN collection's moment contract (a pack
             -- only yields its own collection). Box packs (which yield PackNFTs) exist only
             -- for Top Shot, whose ids Atlas never exposes (every one reads "0").
             'nfts', (SELECT string_agg(public.atlas_moment_token_prefix(p_product) || x, ', ')
                        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p->'nfts') = 'array' THEN p->'nfts' ELSE '[]'::jsonb END) x
                       WHERE x ~ '^[0-9]+$' AND x <> '0' AND public.atlas_moment_token_prefix(p_product) IS NOT NULL),
             'distribution', NULL))), '[]'::jsonb)
      INTO v_edges
      FROM jsonb_array_elements(j->'packs') p;
    v_more := coalesce((j->'pagination'->>'hasMore')::boolean, false);
    -- Advance by the page LIMIT, not the rows returned: an empty page that still says hasMore
    -- must not re-request the same offset for ever (the page caps bound the walk either way).
    v_next := (coalesce((j->'pagination'->>'offset')::bigint, 0)
               + coalesce(NULLIF((j->'pagination'->>'limit')::bigint, 0), jsonb_array_length(j->'packs')))::text;
  ELSE
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('data', jsonb_build_object('searchPackNft', jsonb_build_object(
    'edges', v_edges,
    'pageInfo', jsonb_build_object('hasNextPage', v_more, 'endCursor', CASE WHEN v_more THEN v_next END))));
END
$f$;

-- New helpers: no client role needs any of them (the lanes run as the owner via pg_cron).
REVOKE ALL ON FUNCTION public.atlas_pack_dispatch(text, text, text, bigint, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_pack_to_studio(text, integer, text, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_pack_type_name(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_moment_token_prefix(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_next_pack_product(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_pack_dispatch(text, text, text, bigint, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_pack_to_studio(text, integer, text, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_pack_type_name(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_moment_token_prefix(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_next_pack_product(text, text) TO service_role;
-- anon-exec: unchanged (dispatch_pack_nft_identity) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only
-- anon-exec: unchanged (collect_pack_nft_identity) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only
-- anon-exec: unchanged (request_wallet_pack_sync) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only
-- anon-exec: unchanged (request_wallet_pack_pulls) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only
-- anon-exec: unchanged (collect_wallet_pack_pulls) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only
-- anon-exec: unchanged (run_pack_nft_identity_lane) — CREATE OR REPLACE keeps the ACL; read 11-18: postgres + service_role only

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
    v_skipped := (SELECT count(DISTINCT u.id) FROM unnest(p_pack_nft_ids) AS u(id)) - v_enqueued;
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

CREATE OR REPLACE FUNCTION public.collect_pack_nft_identity()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_returned int;
  v_not_found int;
  v_requests int := 0;
  v_ok int := 0;
  v_failed int := 0;
  v_expired int := 0;
  v_identities int := 0;
  v_misses int := 0;
  v_propagated int := 0;
  v_rips_named int := 0;
  v_dists_seeded int := 0;
  v_requeued int := 0;
  v_wallet_pages int := 0;
  v_wallets_done int := 0;
  v_touched text[] := '{}';
  v_last_error text := NULL;
  v_next bigint;
BEGIN
  -- One collector at a time. A cron tick and a manual run overlapping on
  -- 2026-09-18 both collected the same wallet page and each dispatched the
  -- next one -- a duplicated page chain. The lock is transaction-scoped.
  IF NOT pg_try_advisory_xact_lock(hashtext('collect_pack_nft_identity')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another collector holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  FOR r IN
    -- 2026-11-18 (#218): an Atlas request (q.product set) is translated into the Studio
    -- searchPackNft shape here, so everything below is unchanged. A 404 not_found is a valid
    -- "no such pack" and reads as an empty 200; anything untranslatable keeps its raw status.
    SELECT q.request_id, q.pack_nft_ids, q.dispatched_at, q.kind, q.wallet, q.page, q.product,
           CASE WHEN q.product IS NOT NULL
                 AND public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.pack_nft_ids) IS NOT NULL
                THEN 200 ELSE h.status_code END AS status_code,
           CASE WHEN q.product IS NULL THEN h.content
                ELSE coalesce(public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.pack_nft_ids)::text, h.content)
           END AS content,
           h.error_msg,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_nft_identity_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_nft_identity_requests
           SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        IF r.kind = 'wallet' THEN
          UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'no_response on page ' || r.page
           WHERE wallet = r.wallet AND completed_at IS NULL;
        ELSE
          INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
          SELECT k.collection_id, k.pack_nft_id, max(k.at), 1
          FROM (
            SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
             WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
            UNION ALL
            SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
             WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
          ) k
          WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
          -- A pack both BOUGHT and RIPPED is in both legs: collapse to one row per key, or
          -- ON CONFLICT DO UPDATE aborts the whole collector ("cannot affect row a second time").
          GROUP BY k.collection_id, k.pack_nft_id
          ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
          GET DIAGNOSTICS v_returned = ROW_COUNT;
          v_requeued := v_requeued + v_returned;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    BEGIN
      v_body := CASE WHEN r.status_code = 200 THEN r.content::jsonb ELSE NULL END;
    EXCEPTION WHEN others THEN
      v_body := NULL;
    END;

    IF r.status_code IS DISTINCT FROM 200 OR v_body IS NULL OR v_body->'data'->'searchPackNft'->'edges' IS NULL THEN
      UPDATE public.pack_nft_identity_requests
         SET collected_at = now(), status_code = r.status_code,
             outcome = CASE WHEN r.status_code IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.status_code::text, 'null')
                            WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      v_failed := v_failed + 1;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.error_msg, r.content, ''), 200);
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page ' || r.page || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      ELSE
        INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
        SELECT k.collection_id, k.pack_nft_id, max(k.at), 1
        FROM (
          SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
           WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
          UNION ALL
          SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
           WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
        ) k
        WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
        -- A pack both BOUGHT and RIPPED is in both legs: collapse to one row per key, or
        -- ON CONFLICT DO UPDATE aborts the whole collector ("cannot affect row a second time").
        GROUP BY k.collection_id, k.pack_nft_id
        ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
        GET DIAGNOSTICS v_returned = ROW_COUNT;
        v_requeued := v_requeued + v_returned;
      END IF;
      CONTINUE;
    END IF;

    v_edges := v_body->'data'->'searchPackNft'->'edges';

    -- Identity rows. For an 'ids' request only the ids we asked for; for a
    -- 'wallet' page every node. Collection from type_name; unknown types skipped.
    INSERT INTO public.pack_nft_identity
      (collection_id, pack_nft_id, dist_id, status, owner_address, type_name,
       dist_title, dist_tier, dist_image_url, acquired_at, request_id, checked_at, source)
    SELECT
      CASE e->'node'->>'type_name'
        WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
        WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
        WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
      END,
      e->'node'->>'id',
      NULLIF(e->'node'->>'dist_id', ''),
      coalesce(e->'node'->>'status', 'unknown'),
      CASE WHEN e->'node'->>'owner_address' IS NULL THEN NULL
           WHEN e->'node'->>'owner_address' LIKE '0x%' THEN lower(e->'node'->>'owner_address')
           ELSE '0x' || lower(e->'node'->>'owner_address') END,
      e->'node'->>'type_name',
      NULLIF(e->'node'->'distribution'->>'title', ''),
      NULLIF(e->'node'->'distribution'->>'tier', ''),
      NULLIF(e->'node'->'distribution'->'image_urls'->>0, ''),
      (SELECT max((o->>'nftAcquiredAt')::timestamptz)
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e->'node'->'ownershipHistory') = 'array' THEN e->'node'->'ownershipHistory' ELSE '[]'::jsonb END) o
        WHERE lower(coalesce(o->>'flowAddress', '')) = lower(regexp_replace(coalesce(e->'node'->>'owner_address', ''), '^0x', ''))),
      r.request_id, now(),
      CASE WHEN r.product IS NOT NULL THEN 'atlas_pack_service' ELSE 'dapper_searchPackNft' END
    FROM jsonb_array_elements(v_edges) e
    WHERE e->'node'->>'id' IS NOT NULL
      AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
      AND (r.kind = 'wallet' OR e->'node'->>'id' = ANY (r.pack_nft_ids))
    ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
      SET dist_id = coalesce(EXCLUDED.dist_id, public.pack_nft_identity.dist_id),
          -- Atlas ResolvePackDistribution names the dist but not status/owner: 'unknown' and a
          -- NULL owner must not overwrite what an earlier answer recorded (a not_found becomes unknown).
          status = CASE WHEN EXCLUDED.status = 'unknown'
                        THEN coalesce(NULLIF(public.pack_nft_identity.status, 'not_found'), 'unknown')
                        ELSE EXCLUDED.status END,
          owner_address = coalesce(EXCLUDED.owner_address, public.pack_nft_identity.owner_address),
          type_name = EXCLUDED.type_name,
          dist_title = coalesce(EXCLUDED.dist_title, public.pack_nft_identity.dist_title),
          dist_tier = coalesce(EXCLUDED.dist_tier, public.pack_nft_identity.dist_tier),
          dist_image_url = coalesce(EXCLUDED.dist_image_url, public.pack_nft_identity.dist_image_url),
          acquired_at = coalesce(EXCLUDED.acquired_at, public.pack_nft_identity.acquired_at),
          request_id = EXCLUDED.request_id,
          checked_at = EXCLUDED.checked_at,
          source = EXCLUDED.source;
    GET DIAGNOSTICS v_returned = ROW_COUNT;
    v_identities := v_identities + v_returned;

    v_not_found := 0;
    IF r.kind = 'ids' AND v_returned < cardinality(r.pack_nft_ids) THEN
      INSERT INTO public.pack_nft_identity (collection_id, pack_nft_id, dist_id, status, request_id, checked_at)
      SELECT DISTINCT k.collection_id, u.id, NULL, 'not_found', r.request_id, now()
      FROM unnest(r.pack_nft_ids) AS u(id)
      JOIN (
        SELECT collection_id, pack_nft_id FROM public.pack_purchases WHERE pack_nft_id = ANY (r.pack_nft_ids) AND collection_id IN (v_ts, v_ad)
        UNION
        SELECT collection_id, pack_nft_id FROM public.pack_rips WHERE pack_nft_id = ANY (r.pack_nft_ids) AND collection_id IN (v_ts, v_ad)
      ) k ON k.pack_nft_id = u.id
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_edges) e WHERE e->'node'->>'id' = u.id)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
      GET DIAGNOSTICS v_not_found = ROW_COUNT;
      v_misses := v_misses + v_not_found;
    END IF;

    UPDATE public.pack_nft_identity_requests
       SET collected_at = now(), status_code = 200, outcome = 'ok',
           n_returned = v_returned, n_not_found = v_not_found
     WHERE request_id = r.request_id;
    v_ok := v_ok + 1;

    IF r.kind = 'wallet' THEN
      v_wallet_pages := v_wallet_pages + 1;
      v_touched := v_touched || coalesce((SELECT array_agg(e->'node'->>'id') FROM jsonb_array_elements(v_edges) e), '{}');
      UPDATE public.pack_wallet_sync
         SET pages = pages + 1, packs = packs + v_returned
       WHERE wallet = r.wallet;
      -- Four outcomes, and only the first two END the sync. A concurrent
      -- collector may already have dispatched this same next page (the cursor
      -- guard below): that is "still in flight", NOT "finished" — stamping
      -- completed_at there is how 6 wallets read "confirmed (700 packs)" while
      -- page 6 was still on the wire (2026-09-19 02:22 UTC, caught before push).
      IF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL)
         AND public.atlas_next_pack_product('sync', r.product) IS NOT NULL THEN
        -- Atlas walks one product at a time: this one is done, start the next at offset 0.
        v_next := public.atlas_pack_dispatch('owner', public.atlas_next_pack_product('sync', r.product), r.wallet, 0, NULL);
        INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page, product)
        VALUES (v_next, '{}', 0, 'wallet', r.wallet, NULL, coalesce(r.page, 1) + 1, public.atlas_next_pack_product('sync', r.product));
      ELSIF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF r.product IS NULL THEN
        -- A walk started on Studio carries a Studio cursor, not an Atlas offset: it cannot be
        -- continued. End it with the reason; the next sweep restarts the wallet on Atlas.
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': a Studio walk cannot continue on Atlas (#218); the next sweep restarts it' WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 300 THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page cap 300 reached (Atlas pages hold 200 packs); holdings beyond it not walked' WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.pack_nft_identity_requests d
                          WHERE d.kind = 'wallet' AND d.wallet = r.wallet
                            AND d.after_cursor = v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor'
                            AND d.dispatched_at > now() - interval '2 hours'
                            -- ... AND IT IS STILL IN FLIGHT. Matching on dispatched_at
                            -- alone let an ALREADY-COLLECTED request from a PREVIOUS cycle
                            -- suppress this cycle's dispatch, and nothing could ever complete
                            -- the sync because the row it waited on was already done.
                            AND d.collected_at IS NULL) THEN
        v_next := public.atlas_pack_dispatch('owner', coalesce(r.product, 'nba'), r.wallet,
                    (v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor')::bigint, NULL);
        INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page, product)
        VALUES (v_next, '{}', 0, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1, coalesce(r.product, 'nba'));
      END IF;  -- else: the next page is already in flight; the sync stays open
    ELSE
      v_touched := v_touched || r.pack_nft_ids;
    END IF;
  END LOOP;

  IF cardinality(v_touched) > 0 THEN
    INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
    SELECT DISTINCT ON (i.collection_id, i.dist_id)
           i.collection_id, i.dist_id, i.dist_title, i.type_name, i.dist_image_url,
           jsonb_strip_nulls(jsonb_build_object('tier', i.dist_tier, 'seeded_from', 'dapper_searchPackNft'))
    FROM public.pack_nft_identity i
    WHERE i.pack_nft_id = ANY (v_touched)
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND i.dist_title IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                       WHERE pd.collection_id = i.collection_id AND pd.dist_id = i.dist_id)
    ORDER BY i.collection_id, i.dist_id, i.checked_at DESC
    ON CONFLICT (dist_id, collection_id) DO NOTHING;
    GET DIAGNOSTICS v_dists_seeded = ROW_COUNT;

    WITH named AS (
      UPDATE public.pack_rips pr
         SET dist_id = i.dist_id
        FROM public.pack_nft_identity i
       WHERE i.collection_id = pr.collection_id
         AND i.pack_nft_id = pr.pack_nft_id
         AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
         AND pr.dist_id IS NULL
         AND pr.pack_nft_id = ANY (v_touched)
      RETURNING pr.id, pr.dist_id
    ), attributed AS (
      INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence, n_editions)
      SELECT n.id, n.dist_id, 'dapper_index', 'high', NULL FROM named n
      ON CONFLICT (rip_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_rips_named FROM named;

    UPDATE public.pack_purchases pp
       SET pack_dist_id = i.dist_id
      FROM public.pack_nft_identity i
     WHERE i.collection_id = pp.collection_id
       AND i.pack_nft_id = pp.pack_nft_id
       AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
       AND pp.pack_dist_id IS NULL
       AND pp.pack_nft_id = ANY (v_touched);
    GET DIAGNOSTICS v_propagated = ROW_COUNT;

    DELETE FROM public.pack_nft_identity_queue q
    USING public.pack_nft_identity i
    WHERE i.collection_id = q.collection_id AND i.pack_nft_id = q.pack_nft_id
      AND q.pack_nft_id = ANY (v_touched);
  END IF;

  PERFORM public.log_pipeline_run(
    'pack-nft-identity', v_started,
    v_requests, v_identities, v_misses,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                       'propagated_to_pack_purchases', v_propagated, 'rips_named', v_rips_named,
                       'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages, 'wallets_done', v_wallets_done)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                            'propagated', v_propagated, 'rips_named', v_rips_named,
                            'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages,
                            'wallets_done', v_wallets_done, 'last_error', v_last_error);
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_wallet_pack_sync(p_wallet text, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_sync public.pack_wallet_sync%ROWTYPE;
  v_req bigint;
BEGIN
  IF v_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not a Flow address');
  END IF;

  SELECT * INTO v_sync FROM public.pack_wallet_sync WHERE wallet = v_wallet;
  IF FOUND AND NOT p_force THEN
    -- in flight: requested, not completed, and not stale enough to be a lost request
    IF v_sync.completed_at IS NULL AND v_sync.requested_at > now() - interval '2 hours' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'in_progress', 'requested_at', v_sync.requested_at);
    END IF;
    IF v_sync.completed_at IS NOT NULL AND v_sync.completed_at > now() - interval '1 hour' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'fresh', 'completed_at', v_sync.completed_at);
    END IF;
  END IF;

  INSERT INTO public.pack_wallet_sync (wallet, requested_at, completed_at, pages, packs, last_error)
  VALUES (v_wallet, now(), NULL, 0, 0, NULL)
  ON CONFLICT (wallet) DO UPDATE
    SET requested_at = now(), completed_at = NULL, pages = 0, packs = 0, last_error = NULL;

  -- 2026-11-18 (#218): Atlas PackService/GetPacksByOwner, one product at a time (nba, then
  -- nfl, then laliga -- collect_pack_nft_identity chains them). Studio is HTTP 530.
  v_req := public.atlas_pack_dispatch('owner', 'nba', v_wallet, 0, NULL);

  INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page, product)
  VALUES (v_req, '{}', 0, 'wallet', v_wallet, NULL, 1, 'nba');

  RETURN jsonb_build_object('ok', true, 'reason', 'dispatched', 'request_id', v_req);
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_wallet_pack_pulls(p_wallet text, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
AS $function$
DECLARE
  v_wallet text := lower(trim(coalesce(p_wallet, '')));
  v_state  public.pack_pull_wallet_state%ROWTYPE;
  v_req    bigint;
BEGIN
  -- Flow addresses only: the index is keyed by the 16-hex Flow address.
  IF v_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not a flow address');
  END IF;

  SELECT * INTO v_state FROM public.pack_pull_wallet_state WHERE wallet = v_wallet;

  IF NOT p_force AND FOUND THEN
    -- in flight (and not abandoned)
    IF v_state.completed_at IS NULL AND v_state.requested_at > now() - interval '2 hours' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'in_flight', 'requested_at', v_state.requested_at);
    END IF;
    -- fresh
    IF v_state.completed_at IS NOT NULL AND v_state.last_error IS NULL
       AND v_state.completed_at > now() - interval '6 hours' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'fresh', 'completed_at', v_state.completed_at);
    END IF;
  END IF;

  -- 2026-11-18 (#218): Atlas PackService/GetPacksByOwner, All Day then Golazos
  -- (collect_wallet_pack_pulls chains them). Top Shot is not walked: Atlas returns "0" for every
  -- Top Shot pulled-moment id, so a walk there could record no pull. Studio is HTTP 530.
  v_req := public.atlas_pack_dispatch('owner', 'nfl', v_wallet, 0, NULL);

  INSERT INTO public.pack_pull_requests (request_id, kind, wallet, page, product)
  VALUES (v_req, 'wallet', v_wallet, 1, 'nfl');

  INSERT INTO public.pack_pull_wallet_state (wallet, requested_at, completed_at, pages, packs, pulls, last_error)
  VALUES (v_wallet, now(), NULL, 0, 0, 0, NULL)
  ON CONFLICT (wallet) DO UPDATE
    SET requested_at = now(), completed_at = NULL, pages = 0, packs = 0, pulls = 0, last_error = NULL;

  RETURN jsonb_build_object('ok', true, 'reason', 'dispatched', 'request_id', v_req);
END;
$function$;

CREATE OR REPLACE FUNCTION public.collect_wallet_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid; v_ad uuid; v_gz uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_n int;
  v_next bigint;
  v_requests int := 0; v_ok int := 0; v_failed int := 0; v_expired int := 0;
  v_pages int := 0; v_wallets_done int := 0;
  v_pulls_new int := 0; v_api_named int := 0; v_local_named int := 0;
  v_lookups int := 0; v_priced_packs int := 0; v_valued_packs int := 0;
  v_last_error text := NULL;
  v_touched_packs text[] := '{}';
  b record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('collect_wallet_pack_pulls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another collector holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  -- (1) Collect every landed request.
  FOR r IN
    -- 2026-11-18 (#218): an Atlas request (q.product set) is translated into the Studio shape
    -- here (searchPackNft for wallet pages, searchAllDayNft for edition lookups), so the parsing
    -- below is unchanged. Anything untranslatable keeps its raw status and fails as before.
    SELECT q.*,
           CASE WHEN q.product IS NOT NULL
                 AND public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.nft_ids) IS NOT NULL
                THEN 200 ELSE h.status_code END AS h_status,
           CASE WHEN q.product IS NULL THEN h.content
                ELSE coalesce(public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.nft_ids)::text, h.content)
           END AS h_content,
           h.error_msg AS h_error,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_pull_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_pull_requests SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        IF r.kind = 'wallet' THEN
          UPDATE public.pack_pull_wallet_state
             SET completed_at = now(), last_error = 'no_response on page ' || coalesce(r.page, 1)
           WHERE wallet = r.wallet AND completed_at IS NULL;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
                   THEN r.h_content::jsonb END;
    v_edges := CASE r.kind
                 WHEN 'wallet' THEN v_body->'data'->'searchPackNft'->'edges'
                 ELSE coalesce(v_body->'data'->'searchAllDayNft'->'edges',
                               v_body->'data'->'searchGolazosNft'->'edges')
               END;

    IF v_body IS NULL OR jsonb_typeof(v_edges) IS DISTINCT FROM 'array' THEN
      v_failed := v_failed + 1;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.h_error, r.h_content, 'http ' || r.h_status), 200);
      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = r.h_status,
             outcome = CASE WHEN r.h_status IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.h_status::text, 'null')
                            WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      END IF;
      CONTINUE;
    END IF;

    IF r.kind = 'wallet' THEN
      -- 2026-09-29: a BOX yields packs, not moments ("A.<addr>.PackNFT.<id>",
      -- e.g. "2026 NBA Finals Box" -> 8 PackNFTs). Those go to
      -- pack_box_contents; before, each was stored as an unnamed moment and the
      -- box read "0 of 8 priced" for ever (430 Top Shot boxes, 12 wallets).
      -- 2026-10-10 (#188): ... and each NEW inner pack the index does not name yet is queued for
      -- the pack-nft-identity lane. The per-owner sync cannot see one the opener sold or sent on
      -- sealed (1,516 of 3,404 had no identity row), so its dist was never learned.
      WITH box_ins AS (
      INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
      SELECT DISTINCT
             CASE e->'node'->>'type_name'
               WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
               WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
               WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
             END,
             e->'node'->>'id',
             split_part(t.tok, '.', 4),
             r.wallet
      FROM jsonb_array_elements(v_edges) e
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(e->'node'->>'nfts', ''), '\s*,\s*') AS t(tok)
      WHERE (e->'node'->>'status' = 'Opened'
             -- 2026-10-19: a Top Shot pack Dapper left at 'Revealed' WAS opened (see header)
             OR (e->'node'->>'status' = 'Revealed' AND e->'node'->>'type_name' = 'A.0b2a3299cc857e29.PackNFT.NFT'))
        AND e->'node'->>'id' IS NOT NULL
        AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
        AND t.tok ~ '^A\.[0-9a-f]+\.PackNFT\.[0-9]+$'
        -- 2026-10-19: a Revealed box's nfts can name a pack that was never this wallet's -- the open
        -- stalled because one assigned pack had already been sold to someone else (37 of 37 Revealed
        -- boxes: 45 of 259 listed packs first withdrawn by a third party; 0 of 3,404 on Opened boxes).
        -- Keep it out when a primary withdraw sent it to anyone but this wallet or the PDS contract.
        AND NOT (e->'node'->>'status' = 'Revealed' AND EXISTS (
              SELECT 1 FROM public.pack_purchases pp
               WHERE pp.pack_nft_id = split_part(t.tok, '.', 4)
                 AND pp.collection_id = v_ts
                 AND pp.event_kind = 'primary_withdraw'
                 AND pp.buyer_address NOT IN (r.wallet, '0xb6f2481eba4df97b')))
      ON CONFLICT (collection_id, box_pack_nft_id, pack_nft_id) DO NOTHING
      RETURNING collection_id, pack_nft_id
      )
      INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
      SELECT DISTINCT bi.collection_id, bi.pack_nft_id, now()
      FROM box_ins bi
      WHERE bi.collection_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                         WHERE pi.collection_id = bi.collection_id AND pi.pack_nft_id = bi.pack_nft_id)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

      -- "A.<addr>.<Contract>.<id>" per pulled moment; the collection is the
      -- PACK's contract (a pack only ever yields its own collection's moments).
      WITH ins AS (
        INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address)
        SELECT DISTINCT
               CASE e->'node'->>'type_name'
                 WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
                 WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
                 WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
               END,
               e->'node'->>'id',
               split_part(t.tok, '.', 4),
               r.wallet
        FROM jsonb_array_elements(v_edges) e
        CROSS JOIN LATERAL regexp_split_to_table(coalesce(e->'node'->>'nfts', ''), '\s*,\s*') AS t(tok)
        WHERE (e->'node'->>'status' = 'Opened'
             -- 2026-10-19: a Top Shot pack Dapper left at 'Revealed' WAS opened (see header)
             OR (e->'node'->>'status' = 'Revealed' AND e->'node'->>'type_name' = 'A.0b2a3299cc857e29.PackNFT.NFT'))
          AND e->'node'->>'id' IS NOT NULL
          AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
          AND t.tok ~ '^A\.[0-9a-f]+\.[A-Za-z]+\.[0-9]+$'
          AND split_part(t.tok, '.', 3) <> 'PackNFT'
        ON CONFLICT (collection_id, pack_nft_id, nft_id) DO NOTHING
        RETURNING pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}') INTO v_n, v_touched_packs FROM ins;
      v_pulls_new := v_pulls_new + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
      v_pages := v_pages + 1;

      UPDATE public.pack_pull_wallet_state s
         SET pages = s.pages + 1,
             packs = s.packs + jsonb_array_length(v_edges),
             pulls = (SELECT count(*) FROM public.pack_open_pulls p WHERE p.opener_address = r.wallet)
       WHERE s.wallet = r.wallet;

      -- Three outcomes; only the first two END the walk. A next page already
      -- in flight is "still walking", never "done".
      IF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL)
         AND public.atlas_next_pack_product('pulls', r.product) IS NOT NULL THEN
        -- Atlas walks one product at a time: this one is done, start the next at offset 0.
        v_next := public.atlas_pack_dispatch('owner', public.atlas_next_pack_product('pulls', r.product), r.wallet, 0, NULL);
        INSERT INTO public.pack_pull_requests (request_id, kind, wallet, after_cursor, page, product)
        VALUES (v_next, 'wallet', r.wallet, NULL, coalesce(r.page, 1) + 1, public.atlas_next_pack_product('pulls', r.product));
      ELSIF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_pull_wallet_state SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF r.product IS NULL THEN
        -- A walk started on Studio carries a Studio cursor, not an Atlas offset: it cannot be
        -- continued. End it with the reason; the next sweep restarts the wallet on Atlas.
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': a Studio walk cannot continue on Atlas (#218); the next sweep restarts it'
         WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 100 THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page cap 100 reached (Atlas pages hold 200 packs); packs beyond it not walked'
         WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.pack_pull_requests d
                         WHERE d.kind = 'wallet' AND d.wallet = r.wallet
                           AND d.after_cursor = v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor'
                           AND d.collected_at IS NULL) THEN
        v_next := public.atlas_pack_dispatch('owner', coalesce(r.product, 'nfl'), r.wallet,
                    (v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor')::bigint, NULL);
        INSERT INTO public.pack_pull_requests (request_id, kind, wallet, after_cursor, page, product)
        VALUES (v_next, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1, coalesce(r.product, 'nfl'));
      END IF;

    ELSE
      -- edition lookup: node.edition.id is the collection's on-chain edition id,
      -- which is editions.external_id for All Day and Golazos.
      WITH named AS (
        UPDATE public.pack_open_pulls p
           SET edition_id = ed.id, resolved_via = CASE WHEN r.product IS NOT NULL THEN 'atlas_api' ELSE 'studio_api' END, resolved_at = now()
          FROM jsonb_array_elements(v_edges) e
          JOIN public.editions ed
            ON ed.collection_id = r.collection_id
           AND ed.external_id = e->'node'->'edition'->>'id'
         WHERE p.collection_id = r.collection_id
           AND p.nft_id = e->'node'->>'id'
           AND p.edition_id IS NULL
        RETURNING p.pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}')
        INTO v_n, v_touched_packs FROM named;
      v_api_named := v_api_named + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
    END IF;

    -- packs whose inputs changed this tick are repriced below
    IF cardinality(v_touched_packs) > 0 THEN
      UPDATE public.pack_open_pull_values SET priced_at = '-infinity'
       WHERE pack_nft_id = ANY (v_touched_packs);
      INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
      SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
        FROM public.pack_open_pulls p WHERE p.pack_nft_id = ANY (v_touched_packs)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    END IF;
  END LOOP;

  -- (2) Resolve editions from what we already hold. Oldest-checked first, stamped
  -- with clock_timestamp() so an unresolvable row rotates to the back instead of
  -- re-occupying the head every tick. moment ids are unique only WITHIN a
  -- collection, so every probe is collection-scoped.
  WITH cand AS MATERIALIZED (
    SELECT p.collection_id, p.pack_nft_id, p.nft_id
    FROM public.pack_open_pulls p
    WHERE p.edition_id IS NULL
    ORDER BY p.local_checked_at NULLS FIRST
    LIMIT 4000
  ), found AS (
    SELECT c.*, coalesce(m.edition_id, ap.edition_id, gz.id, wm.id,
                         CASE WHEN tx.n_named = 1 THEN tx.edition_id END) AS edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments'
                WHEN ap.edition_id IS NOT NULL THEN 'allday_pack_pull'
                WHEN gz.id IS NOT NULL THEN 'golazos_pack_open_pulls'
                WHEN wm.id IS NOT NULL THEN 'wallet_moments_cache'
                WHEN tx.n_named = 1 THEN tx.via END AS via
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT mo.edition_id FROM public.moments mo
       WHERE mo.nft_id = c.nft_id AND mo.collection_id = c.collection_id AND mo.edition_id IS NOT NULL
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT a.edition_id FROM public.allday_pack_pull a
       WHERE c.collection_id = v_ad AND a.pack_nft_id = c.pack_nft_id AND a.moment_nft_id = c.nft_id
         AND a.edition_id IS NOT NULL
       LIMIT 1
    ) ap ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.golazos_pack_open_pulls g
        JOIN public.editions ed ON ed.collection_id = v_gz AND ed.external_id = g.edition_external_id
       WHERE c.collection_id = v_gz AND g.nft_id = c.nft_id
       LIMIT 1
    ) gz ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.wallet_moments_cache w
        JOIN public.editions ed ON ed.collection_id = w.collection_id AND ed.external_id = w.edition_key
       WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id AND w.edition_key IS NOT NULL
       LIMIT 1
    ) wm ON true
    -- 2026-09-26: a Top Shot moment that has LEFT the wallet is in neither
    -- moments nor the wallet cache, and Dapper's Top Shot index answers nothing
    -- -- 31,128 pulls sat unnamed. Four records we already hold name one by its
    -- id: a recorded sale, the on-chain ownership walk, the nft->edition map, and
    -- a Standard Atlas market event (parallels there matched 92 %, Standard
    -- 99.9 %, so parallels are not used). Named only when every source that
    -- answers agrees; a conflict stays unnamed. Top Shot only, product 'nba'.
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT o.edition_id) AS n_named,
             min(o.edition_id::text)::uuid AS edition_id,
             string_agg(DISTINCT o.via, '+' ORDER BY o.via) AS via
      FROM (
        SELECT s.edition_id, 'sales'::text AS via FROM public.sales s
         WHERE c.collection_id = v_ts AND s.collection_id = v_ts AND s.nft_id = c.nft_id
           AND s.edition_id IS NOT NULL
        UNION ALL
        SELECT ed.id, 'topshot_ownership' FROM public.topshot_ownership t
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = t.edition_external_id
         WHERE c.collection_id = v_ts AND t.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'nft_edition_map' FROM public.nft_edition_map n
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = n.edition_external_id
         WHERE c.collection_id = v_ts AND n.collection_id = v_ts AND n.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'atlas_market_events' FROM public.topshot_atlas_market_events a
          JOIN public.topshot_atlas_edition_map am ON am.atlas_edition_id = a.atlas_edition_id
          JOIN public.editions ed ON ed.id = am.rpc_edition_id AND ed.collection_id = v_ts
         WHERE c.collection_id = v_ts AND a.product = 'nba' AND a.nft_id = c.nft_id
           AND a.parallel = 'Standard' AND am.parallel = 'Standard'
      ) o
    ) tx ON true
  ), upd AS (
    UPDATE public.pack_open_pulls p
       SET edition_id = f.edition_id,
           resolved_via = f.via,
           resolved_at = CASE WHEN f.edition_id IS NOT NULL THEN now() END,
           local_checked_at = clock_timestamp()
      FROM found f
     WHERE p.collection_id = f.collection_id AND p.pack_nft_id = f.pack_nft_id AND p.nft_id = f.nft_id
    RETURNING p.collection_id, p.pack_nft_id, (f.edition_id IS NOT NULL) AS named
  ), bump AS (
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT collection_id, pack_nft_id FROM upd WHERE named) u
     WHERE v.collection_id = u.collection_id AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE named) INTO v_local_named FROM upd;

  -- (3) Ask Dapper's index for what is still unnamed (All Day, Golazos only --
  -- its Top Shot index returns nothing). 200 ids a request, 5 requests a tick,
  -- each id at most 5 times, at least 6 h apart.
  FOR b IN
    WITH pend AS (
      SELECT p.collection_id, p.nft_id,
             row_number() OVER (PARTITION BY p.collection_id ORDER BY p.api_checked_at NULLS FIRST, p.nft_id) AS rn
      FROM public.pack_open_pulls p
      WHERE p.edition_id IS NULL
        AND p.collection_id IN (v_ad, v_gz)
        AND p.local_checked_at IS NOT NULL
        AND p.api_attempts < 5
        AND (p.api_checked_at IS NULL OR p.api_checked_at < now() - interval '6 hours')
        AND NOT EXISTS (SELECT 1 FROM public.pack_pull_requests q
                         WHERE q.kind = 'editions' AND q.collected_at IS NULL AND p.nft_id = ANY (q.nft_ids))
    )
    SELECT collection_id, array_agg(DISTINCT nft_id) AS ids
    FROM pend
    WHERE rn <= 1000
    GROUP BY collection_id, (rn - 1) / 200
    ORDER BY collection_id, min(rn)
    LIMIT 5
  LOOP
    -- 2026-11-18 (#218): Atlas NFTService/GetNFTs (id -> edition + serial; verified against
    -- Studio's answer: All Day 5840678 -> edition 2387 both). Studio is HTTP 530.
    v_next := public.atlas_pack_dispatch('nfts', CASE WHEN b.collection_id = v_ad THEN 'nfl' ELSE 'laliga' END, NULL, NULL, b.ids);
    INSERT INTO public.pack_pull_requests (request_id, kind, collection_id, nft_ids, product)
    VALUES (v_next, 'editions', b.collection_id, b.ids, CASE WHEN b.collection_id = v_ad THEN 'nfl' ELSE 'laliga' END);
    UPDATE public.pack_open_pulls
       SET api_attempts = api_attempts + 1, api_checked_at = now()
     WHERE collection_id = b.collection_id AND nft_id = ANY (b.ids) AND edition_id IS NULL;
    v_lookups := v_lookups + 1;
  END LOOP;

  -- (4) (Re)price: packs whose inputs changed (priced_at = -infinity), then the
  -- stalest older than 24 h so the value tracks current FMV. Whole-pack,
  -- all-or-nothing; fmv_usd must be > 0 to count as priced.
  INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
  SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
    FROM public.pack_open_pulls p
   WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pull_values v
                      WHERE v.collection_id = p.collection_id AND v.pack_nft_id = p.pack_nft_id)
  ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

  WITH pk AS MATERIALIZED (
    SELECT v.collection_id, v.pack_nft_id
    FROM public.pack_open_pull_values v
    WHERE v.priced_at < now() - interval '24 hours'
    ORDER BY v.priced_at
    LIMIT 1500
  ), agg AS (
    SELECT p.collection_id, p.pack_nft_id,
           count(*)                              AS n_pulls,
           count(p.edition_id)                   AS n_resolved,
           count(f.fmv_usd)                      AS n_priced,
           sum(f.fmv_usd)                        AS total
    FROM pk
    JOIN public.pack_open_pulls p ON p.collection_id = pk.collection_id AND p.pack_nft_id = pk.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd FROM public.fmv_snapshots s
       WHERE p.edition_id IS NOT NULL
         AND s.collection_id = p.collection_id AND s.edition_id = p.edition_id
       ORDER BY s.computed_at DESC
       LIMIT 1
    ) f0 ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN f0.fmv_usd > 0 THEN f0.fmv_usd END AS fmv_usd) f
    GROUP BY p.collection_id, p.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_pulls = a.n_pulls, n_resolved = a.n_resolved, n_priced = a.n_priced,
           pull_value_usd = CASE WHEN a.n_priced = a.n_pulls THEN round(a.total, 2) END,
           priced_at = clock_timestamp()
      FROM agg a
     WHERE v.collection_id = a.collection_id AND v.pack_nft_id = a.pack_nft_id
    RETURNING v.pull_value_usd
  )
  SELECT count(*), count(pull_value_usd) INTO v_priced_packs, v_valued_packs FROM upd;

  PERFORM public.log_pipeline_run(
    'wallet-pack-pulls', v_started,
    v_requests, v_pulls_new + v_api_named + v_local_named + v_priced_packs, 0,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                       'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                       'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                       'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                            'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                            'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                            'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs,
                            'last_error', v_last_error);
END;
$function$;

CREATE OR REPLACE FUNCTION public.run_pack_nft_identity_lane()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_collect jsonb;
  v_dispatch jsonb;
BEGIN
  v_collect := public.collect_pack_nft_identity();
  v_dispatch := public.dispatch_pack_nft_identity(1, 30, NULL);  -- Atlas: one call per pack, 30 a tick (2026-11-18)
  RETURN jsonb_build_object('collect', v_collect, 'dispatch', v_dispatch);
END;
$function$;
