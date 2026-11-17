-- audit_20260907: cached_listings gets the Dapper-marketplace (Atlas) Top Shot listings too.
--
-- WHY. `cached_listings` is the Flowty-shaped table behind `update_badge_low_ask_from_cached_listings`
-- (badge_editions.low_ask → the edition-level sniper + deals boards), `fmv_from_cached_listings`
-- (ASK_ONLY FMV for editions with no HIGH/MEDIUM sales price) and `/api/profile/market-pulse`'s
-- tier floors. For Top Shot it held the 100 newest Flowty listings (source 'flowty', refreshed
-- every 20 min) while the Dapper marketplace — where Top Shot actually trades — has ~600 open
-- listings the firehose already carries. Every floor derived from this table was a Flowty floor.
--
-- `sync_cached_listings_from_atlas()` writes the same open, verified, mapped listing set
-- `sync_ts_listings_from_atlas` uses, as `source = 'topshot'` rows (delete-then-insert on that
-- source only — the Flowty writer purges only its own source, and this does the same). `moment_id`
-- carries the CANONICAL external_id (`set:play` or `set:play::sub`) so `fmv_from_cached_listings`
-- joins by identity, not by name. `fmv` (Flowty's blended valuation) is NULL — we carry no
-- third-party valuation for these rows; the ask is the only price. `buy_url` is the Moment's
-- nbatopshot.com page. ON CONFLICT (flow_id) DO NOTHING keeps a Flowty row for the same NFT
-- (it carries a valuation this one cannot).
--
-- Folded into the existing tick: atlas_listing_verify_tick() now runs both syncs; the
-- pipeline row's extra carries both.
--
-- REVERT: DELETE FROM public.cached_listings WHERE source = 'topshot' AND collection_id =
--   '95f28a17-224a-4025-96ad-adf8a4c63bfd'; DROP FUNCTION public.sync_cached_listings_from_atlas();
--   re-apply atlas_listing_verify_tick from 20260907020428.

CREATE OR REPLACE FUNCTION public.sync_cached_listings_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_deleted int;
BEGIN
  DELETE FROM public.cached_listings
   WHERE source = 'topshot' AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  INSERT INTO public.cached_listings (id, flow_id, moment_id, player_name, team_name, set_name, series_name, tier,
                                      serial_number, circulation_count, ask_price, fmv, source, buy_url, thumbnail_url,
                                      listing_resource_id, storefront_address, is_locked, listed_at, cached_at, collection_id)
  SELECT DISTINCT ON (ev.nft_id)
         ev.uuid, ev.nft_id, m.external_id,
         COALESCE(e.player_name, e.team_name), e.team_name, e.set_name,
         CASE WHEN e.series IS NULL THEN NULL ELSE 'Series ' || e.series END,
         upper(COALESCE(ev.tier, e.tier::text)),
         ev.serial_number, e.circulation_count, (ev.price_cents::numeric / 100), NULL,
         'topshot', 'https://nbatopshot.com/moment/' || ev.nft_id, e.thumbnail_url,
         ev.listing_resource_id, ev.seller_address, false, ev.listed_at, now(),
         '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
    JOIN public.editions e ON e.id = m.rpc_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours'
   ORDER BY ev.nft_id, ev.listed_at DESC NULLS LAST
  ON CONFLICT (flow_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_n, 'replaced', v_deleted,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

REVOKE ALL ON FUNCTION public.sync_cached_listings_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_cached_listings_from_atlas() TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_sync jsonb; v_cl jsonb; v_disp jsonb; v_err text;
BEGIN
  BEGIN
    v_sync := public.sync_ts_listings_from_atlas();
    v_cl := public.sync_cached_listings_from_atlas();
    v_disp := public.atlas_listing_verify_dispatch(p_max);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-listings-atlas-sync', v_started, 1, COALESCE((v_sync->>'rows')::int, 0),
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('sync', v_sync, 'cached_listings', v_cl, 'verify', v_disp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('sync', v_sync, 'cached_listings', v_cl, 'verify', v_disp, 'error', v_err);
END $$;
-- anon-exec: intentional — same signature as 20260907020428, ACLs preserved (atlas_listing_verify_tick)
