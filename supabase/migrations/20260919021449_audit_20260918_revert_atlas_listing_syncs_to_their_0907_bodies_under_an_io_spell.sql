-- audit_20260918_revert_atlas_listing_syncs_to_their_0907_bodies_under_an_io_spell
--
-- REVERT of 20260919012821 + 20260919014753 (R101), 42 minutes after the first applied.
-- Every pg_cron lane on the instance slowed in two steps that coincide with those two
-- applies (6:28 PM PT: work_mem + the shared _open24 build; 6:48 PM PT: temp_buffers):
-- 0030-0128Z -> 0130-0150Z -> since 0150Z, busy seconds per minute, cron.job_run_details:
--   rpc-ts-listings-atlas-sync        9.5 -> 23.1 -> 52.2  (8 of 10 ticks failed since 0150Z)
--   rpc-allday-unmapped-atlas-resolver 4.2 -> 14.5 -> 21.0  (untouched lane, 3 failed)
--   rpc-atlas-market-drain             4.6 ->  9.4 -> 20.9  (untouched lane)
--   rpc-refresh-wmc-fmv-changed        0.9 ->  2.3 -> 17.8  (untouched lane, other tables)
-- Another session also added lanes in the same window (rpc-pack-nft-identity-lane,
-- rpc-refresh-perfect-mint-premiums), so the cause is NOT established either way — and
-- that is exactly why this reverts: the one variable this session owns is removed, the
-- estate is watched for 10-20 minutes, and the answer is then a measurement. Working
-- hypothesis worth testing: 64 MB local buffers + 48 MB work_mem per tick backend, with
-- the tick running most of every 2 minutes, shrinks the OS page cache on a 2 GB instance
-- and raises everyone's disk reads.
--
-- The four bodies below are extracted VERBATIM from the committed migrations the pins
-- point back to (20260907135757 x2, 20260907024130, 20260908035519), so the two DB-invariant
-- pins match again byte-for-byte. The 1-arg sync_ts_listings_from_atlas(boolean) is dropped
-- and the 0-arg one recreated. work_mem / temp_buffers are RESET by the recreation (a new
-- function carries no proconfig beyond its own SET clause) and reset explicitly below.
--
-- anon-exec: sync_ts_listings_from_atlas (REVOKED from PUBLIC/anon/authenticated below; service_role only)
-- anon-exec: sync_cached_listings_from_atlas (REVOKED below; service_role only)
-- anon-exec: sync_edition_offers_from_atlas (REVOKED below; service_role only)
-- anon-exec: atlas_listing_verify_tick (REVOKED below; service_role only)

DROP FUNCTION IF EXISTS public.sync_ts_listings_from_atlas(boolean);

CREATE OR REPLACE FUNCTION public.sync_ts_listings_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_ins int; v_upd int; v_del int; v_unverified int; v_unmapped int;
BEGIN
  -- Open nba listings we could not map to an edition are counted, never guessed at.
  SELECT count(*) INTO v_unmapped
    FROM public.topshot_atlas_market_events ev
    LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND m.rpc_edition_id IS NULL;
  SELECT count(*) INTO v_unverified
    FROM public.topshot_atlas_market_events ev
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.last_seen_at <= now() - interval '24 hours';

  -- The wanted set. One row per Moment: a relisted Moment carries its superseded listing as
  -- "open" until the verify probe flips it, so the NEWEST listing per nft wins here.
  DROP TABLE IF EXISTS _tsl_want;  -- a caller may run the sync twice in one transaction (the pin does)
  CREATE TEMP TABLE _tsl_want ON COMMIT DROP AS
  SELECT DISTINCT ON (ev.nft_id)
         ev.uuid AS listing_id, ev.nft_id AS flow_id, ev.set_id_onchain AS set_id, ev.play_id_onchain AS play_id,
         COALESCE(NULLIF(split_part(m.external_id, '::', 2), '')::int, 0) AS parallel_id,
         ev.serial_number, e.circulation_count, (ev.price_cents::numeric / 100) AS price_usd,
         ev.seller_address, COALESCE(e.player_name, e.team_name) AS player_name, e.set_name,
         COALESCE(ev.tier, e.tier::text) AS moment_tier, e.series AS series_number,
         false AS is_locked, NULL::text AS asset_path_prefix, ev.last_seen_at AS ingested_at, ev.listed_at
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
    JOIN public.editions e ON e.id = m.rpc_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours'
   ORDER BY ev.nft_id, ev.listed_at DESC NULLS LAST;
  SELECT count(*) INTO v_n FROM _tsl_want;

  -- Gone: rows no longer in the wanted set (sold, cancelled by a verify read, aged out of the window,
  -- or superseded by a newer listing of the same Moment — the newer one's listing_id replaces it).
  DELETE FROM public.ts_listings t WHERE NOT EXISTS (SELECT 1 FROM _tsl_want w WHERE w.listing_id = t.listing_id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- New and changed. The update fires only when a carried column differs.
  WITH up AS (
    INSERT INTO public.ts_listings (listing_id, flow_id, set_id, play_id, parallel_id, serial_number, circulation_count, price_usd,
                                    seller_address, player_name, set_name, moment_tier, series_number, is_locked, asset_path_prefix,
                                    ingested_at, listed_at)
    SELECT w.listing_id, w.flow_id, w.set_id, w.play_id, w.parallel_id, w.serial_number, w.circulation_count, w.price_usd,
           w.seller_address, w.player_name, w.set_name, w.moment_tier, w.series_number, w.is_locked, w.asset_path_prefix,
           w.ingested_at, w.listed_at
      FROM _tsl_want w
    ON CONFLICT (listing_id) DO UPDATE
      SET flow_id = EXCLUDED.flow_id, set_id = EXCLUDED.set_id, play_id = EXCLUDED.play_id, parallel_id = EXCLUDED.parallel_id,
          serial_number = EXCLUDED.serial_number, circulation_count = EXCLUDED.circulation_count, price_usd = EXCLUDED.price_usd,
          seller_address = EXCLUDED.seller_address, player_name = EXCLUDED.player_name, set_name = EXCLUDED.set_name,
          moment_tier = EXCLUDED.moment_tier, series_number = EXCLUDED.series_number, is_locked = EXCLUDED.is_locked,
          asset_path_prefix = EXCLUDED.asset_path_prefix, ingested_at = EXCLUDED.ingested_at, listed_at = EXCLUDED.listed_at
      WHERE (public.ts_listings.flow_id, public.ts_listings.set_id, public.ts_listings.play_id, public.ts_listings.parallel_id,
             public.ts_listings.serial_number, public.ts_listings.circulation_count, public.ts_listings.price_usd,
             public.ts_listings.seller_address, public.ts_listings.player_name, public.ts_listings.set_name,
             public.ts_listings.moment_tier, public.ts_listings.series_number, public.ts_listings.is_locked,
             public.ts_listings.asset_path_prefix, public.ts_listings.ingested_at, public.ts_listings.listed_at)
            IS DISTINCT FROM
            (EXCLUDED.flow_id, EXCLUDED.set_id, EXCLUDED.play_id, EXCLUDED.parallel_id, EXCLUDED.serial_number,
             EXCLUDED.circulation_count, EXCLUDED.price_usd, EXCLUDED.seller_address, EXCLUDED.player_name, EXCLUDED.set_name,
             EXCLUDED.moment_tier, EXCLUDED.series_number, EXCLUDED.is_locked, EXCLUDED.asset_path_prefix,
             EXCLUDED.ingested_at, EXCLUDED.listed_at)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_ins, v_upd FROM up;

  RETURN jsonb_build_object('rows', v_n, 'inserted', v_ins, 'updated', v_upd, 'deleted', v_del,
                            'unverified_24h', v_unverified, 'unmapped', v_unmapped,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

CREATE OR REPLACE FUNCTION public.sync_cached_listings_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_ins int; v_upd int; v_del int;
BEGIN
  DROP TABLE IF EXISTS _cl_want;
  CREATE TEMP TABLE _cl_want ON COMMIT DROP AS
  SELECT DISTINCT ON (ev.nft_id)
         ev.uuid AS id, ev.nft_id AS flow_id, m.external_id AS moment_id,
         COALESCE(e.player_name, e.team_name) AS player_name, e.team_name, e.set_name,
         CASE WHEN e.series IS NULL THEN NULL ELSE 'Series ' || e.series END AS series_name,
         upper(COALESCE(ev.tier, e.tier::text)) AS tier,
         ev.serial_number, e.circulation_count, (ev.price_cents::numeric / 100) AS ask_price,
         'https://nbatopshot.com/moment/' || ev.nft_id AS buy_url, e.thumbnail_url,
         ev.listing_resource_id, ev.seller_address AS storefront_address, ev.listed_at, ev.last_seen_at AS cached_at
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
    JOIN public.editions e ON e.id = m.rpc_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours'
   ORDER BY ev.nft_id, ev.listed_at DESC NULLS LAST;
  SELECT count(*) INTO v_n FROM _cl_want;

  -- Gone: topshot rows (ours) whose Moment is no longer in the wanted set.
  DELETE FROM public.cached_listings c
   WHERE c.source = 'topshot' AND c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND NOT EXISTS (SELECT 1 FROM _cl_want w WHERE w.flow_id = c.flow_id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- New and changed. A flow_id already held by a Flowty row is left to Flowty (the update arm is
  -- restricted to our own rows); an existing topshot row is rewritten only when a column differs.
  WITH up AS (
    INSERT INTO public.cached_listings (id, flow_id, moment_id, player_name, team_name, set_name, series_name, tier,
                                        serial_number, circulation_count, ask_price, fmv, source, buy_url, thumbnail_url,
                                        listing_resource_id, storefront_address, is_locked, listed_at, cached_at, collection_id)
    SELECT w.id, w.flow_id, w.moment_id, w.player_name, w.team_name, w.set_name, w.series_name, w.tier,
           w.serial_number, w.circulation_count, w.ask_price, NULL, 'topshot', w.buy_url, w.thumbnail_url,
           w.listing_resource_id, w.storefront_address, false, w.listed_at, w.cached_at,
           '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      FROM _cl_want w
    ON CONFLICT (flow_id) DO UPDATE
      SET id = EXCLUDED.id, moment_id = EXCLUDED.moment_id, player_name = EXCLUDED.player_name, team_name = EXCLUDED.team_name,
          set_name = EXCLUDED.set_name, series_name = EXCLUDED.series_name, tier = EXCLUDED.tier,
          serial_number = EXCLUDED.serial_number, circulation_count = EXCLUDED.circulation_count, ask_price = EXCLUDED.ask_price,
          buy_url = EXCLUDED.buy_url, thumbnail_url = EXCLUDED.thumbnail_url, listing_resource_id = EXCLUDED.listing_resource_id,
          storefront_address = EXCLUDED.storefront_address, listed_at = EXCLUDED.listed_at, cached_at = EXCLUDED.cached_at
      WHERE public.cached_listings.source = 'topshot'
        AND (public.cached_listings.id, public.cached_listings.moment_id, public.cached_listings.player_name,
             public.cached_listings.team_name, public.cached_listings.set_name, public.cached_listings.series_name,
             public.cached_listings.tier, public.cached_listings.serial_number, public.cached_listings.circulation_count,
             public.cached_listings.ask_price, public.cached_listings.buy_url, public.cached_listings.thumbnail_url,
             public.cached_listings.listing_resource_id, public.cached_listings.storefront_address,
             public.cached_listings.listed_at, public.cached_listings.cached_at)
            IS DISTINCT FROM
            (EXCLUDED.id, EXCLUDED.moment_id, EXCLUDED.player_name, EXCLUDED.team_name, EXCLUDED.set_name,
             EXCLUDED.series_name, EXCLUDED.tier, EXCLUDED.serial_number, EXCLUDED.circulation_count, EXCLUDED.ask_price,
             EXCLUDED.buy_url, EXCLUDED.thumbnail_url, EXCLUDED.listing_resource_id, EXCLUDED.storefront_address,
             EXCLUDED.listed_at, EXCLUDED.cached_at)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_ins, v_upd FROM up;

  RETURN jsonb_build_object('rows', v_n, 'inserted', v_ins, 'updated', v_upd, 'deleted', v_del,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_nulled int; v_offers int;
BEGIN
  WITH floor AS (
    SELECT DISTINCT ON (m.external_id)
           m.external_id, (ev.price_cents::numeric / 100) AS low_ask, ev.serial_number, ev.nft_id
      FROM public.topshot_atlas_market_events ev
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
       AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
       AND ev.last_seen_at > now() - interval '24 hours'
       AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
     ORDER BY m.external_id, ev.price_cents ASC, ev.serial_number ASC NULLS LAST
  ), up AS (
    INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
      FROM floor f
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET low_ask = EXCLUDED.low_ask,
          low_ask_serial = EXCLUDED.low_ask_serial,
          low_ask_nft_id = EXCLUDED.low_ask_nft_id,
          updated_at = now()
      WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
         OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM up;

  -- (a) evidence-based NULL: verified COMPLETE within 24 h, and no open listing remains.
  WITH gone AS (
    SELECT m.external_id
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.complete AND v.verified_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id
                          AND ev.kind = 'listing' AND NOT ev.completed AND ev.price_cents > 0)
  ), nulled AS (
    UPDATE public.edition_offers eo
       SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
      FROM gone g
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = g.external_id
       AND eo.low_ask IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_nulled FROM nulled;

  -- (b) highest_offer for editions verified within 24 h: MAX open EDITION/PARALLEL offer, else NULL
  --     when the verification was complete. Serial offers are not an edition's offer.
  WITH ver AS (
    SELECT m.external_id, v.complete,
           (SELECT max(ev.price_cents) FROM public.topshot_atlas_market_events ev
             WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id AND ev.kind = 'offer'
               AND NOT ev.completed AND ev.offer_type IN ('EDITION', 'PARALLEL') AND ev.price_cents > 0
               AND ev.last_seen_at > now() - interval '24 hours') AS best_cents
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.verified_at > now() - interval '24 hours'
       AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), off AS (
    INSERT INTO public.edition_offers (collection_id, external_id, highest_offer, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', ver.external_id, ver.best_cents::numeric / 100, now()
      FROM ver
     WHERE ver.best_cents IS NOT NULL
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET highest_offer = EXCLUDED.highest_offer, updated_at = now()
      WHERE public.edition_offers.highest_offer IS DISTINCT FROM EXCLUDED.highest_offer
    RETURNING 1
  ), off_null AS (
    UPDATE public.edition_offers eo
       SET highest_offer = NULL, updated_at = now()
      FROM ver
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = ver.external_id
       AND ver.complete AND ver.best_cents IS NULL AND eo.highest_offer IS NOT NULL
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM off) + (SELECT count(*) FROM off_null) INTO v_offers;

  RETURN jsonb_build_object('rows', v_n, 'nulled', v_nulled, 'offers', v_offers,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_settle jsonb; v_sync jsonb; v_cl jsonb; v_eo jsonb; v_disp jsonb; v_edisp jsonb; v_err text;
BEGIN
  BEGIN
    v_settle := public.atlas_edition_verify_settle();
    v_sync := public.sync_ts_listings_from_atlas();
    v_cl := public.sync_cached_listings_from_atlas();
    v_eo := public.sync_edition_offers_from_atlas();
    v_disp := public.atlas_listing_verify_dispatch(p_max);
    v_edisp := public.atlas_edition_verify_dispatch(4);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-listings-atlas-sync', v_started, 1, COALESCE((v_sync->>'rows')::int, 0),
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('settle', v_settle, 'sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo,
                       'verify', v_disp, 'edition_verify', v_edisp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('settle', v_settle, 'sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo,
                            'verify', v_disp, 'edition_verify', v_edisp, 'error', v_err);
END $$;

ALTER FUNCTION public.sync_ts_listings_from_atlas() RESET work_mem;
ALTER FUNCTION public.sync_cached_listings_from_atlas() RESET work_mem;
ALTER FUNCTION public.sync_edition_offers_from_atlas() RESET work_mem;
ALTER FUNCTION public.atlas_listing_verify_tick(integer) RESET temp_buffers;

REVOKE ALL ON FUNCTION public.sync_ts_listings_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_cached_listings_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_listing_verify_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ts_listings_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_cached_listings_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_edition_offers_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_listing_verify_tick(int) TO service_role;
