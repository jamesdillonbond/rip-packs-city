-- audit_20260924_ts_listings_sync_withholds_and_counts_stub_edition_listings_instead_of_aborting_the_tick
--
-- Handoff 2026-09-24 20:15 PT, finding 2. `ts-listings-atlas-sync` (pg_cron, the Top Shot sniper
-- feed) failed one whole tick at 2026-09-23 9:56 PM PT with
--   null value in column "circulation_count" of relation "ts_listings" violates not-null constraint
-- — the same minute `20260924045639_audit_20260923_topshot_catalog_new_sets_and_editions_from_atlas`
-- created STUB editions (a new set lands its editions before their mint counts). One listing on a
-- stub edition aborted the tick, and because every leg runs in one transaction under
-- atlas_listing_verify_tick's EXCEPTION block, cached_listings / edition_offers / the verify
-- dispatch rolled back with it. It recurs whenever a new set lands.
--
-- Measured before the fix: 863 ok / 1 failed over 72 h, the 1 = this error; 0 open verified
-- listings on NULL-circulation editions at 2026-09-24 ~9 PM PT, so this ships the
-- guard before the next set, not a live outage.
--
-- Fix: the wanted set skips a listing whose edition has no circulation_count (WHERE e.circulation_count
-- IS NOT NULL) and the payload COUNTS it every tick (`no_circulation`) — withheld and counted, never
-- given a made-up count (COALESCE would fabricate the denominator of the serial-vs-mint read the
-- sniper shows). Nothing else in the body changes. cached_listings.circulation_count is nullable
-- and keeps carrying such rows as before.
--
-- Pin: supabase/tests/sync_ts_listings_from_atlas.sql (fixture ts_listings.circulation_count is now
-- NOT NULL as live; stub edition E4 / listing u10; the previous body fails it with the exact prod
-- error). Revert: re-apply the body of 20260919152824 (drops the filter and the payload key).
--
-- anon-exec: sync_ts_listings_from_atlas (REVOKED from PUBLIC/anon/authenticated below; service_role only, as before)


CREATE OR REPLACE FUNCTION public.sync_ts_listings_from_atlas(p_diag boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_ins int; v_upd int; v_del int; v_unverified int; v_unmapped int; v_nocirc int;
BEGIN
  -- Diagnostics: open nba listings we could not map to an edition are counted, never guessed
  -- at, and listings the verify probes have not re-seen in 24 h are counted the same way.
  -- Both are slow-moving stocks read off a ~400k-row index (42k + 23k buffers per read), so
  -- the tick SAMPLES them (p_diag) — an unsampled tick publishes NULL, never 0.
  IF p_diag THEN
    SELECT count(*) INTO v_unmapped
      FROM public.topshot_atlas_market_events ev
      LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND m.rpc_edition_id IS NULL;
    SELECT count(*) INTO v_unverified
      FROM public.topshot_atlas_market_events ev
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.last_seen_at <= now() - interval '24 hours';
  END IF;

  -- The open book, built ONCE per transaction: every open, verified-in-24h, MAPPED nba listing
  -- with a price — the event and map columns only (slim: the 09-18 version carried editions'
  -- columns too and spilled its local buffers). Raw rows — one Moment may carry several (a
  -- relisted Moment keeps its superseded listing "open" until the verify probe flips it); each
  -- consumer applies its own editions join, DISTINCT ON and ordering below, exactly as it did
  -- against the base tables.
  DROP TABLE IF EXISTS _open24;  -- a caller may run the sync twice in one transaction (the pin does)
  CREATE TEMP TABLE _open24 ON COMMIT DROP AS
  SELECT ev.uuid, ev.nft_id, ev.atlas_edition_id, ev.set_id_onchain, ev.play_id_onchain, ev.serial_number,
         ev.price_cents, ev.seller_address, ev.tier AS ev_tier, ev.listed_at, ev.last_seen_at, ev.listing_resource_id,
         m.external_id, m.rpc_edition_id
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours';

  -- The wanted set. One row per Moment: the NEWEST listing per nft wins. A listing whose edition
  -- has no circulation_count yet (a catalog STUB — a new set lands its editions before their
  -- mint counts) is WITHHELD and COUNTED (no_circulation), never given a made-up count:
  -- ts_listings.circulation_count is NOT NULL, and one such row used to abort the whole tick
  -- (2026-09-24 04:56Z, the minute the catalog migration created stub editions).
  DROP TABLE IF EXISTS _tsl_want;
  CREATE TEMP TABLE _tsl_want ON COMMIT DROP AS
  SELECT DISTINCT ON (o.nft_id)
         o.uuid AS listing_id, o.nft_id AS flow_id, o.set_id_onchain AS set_id, o.play_id_onchain AS play_id,
         COALESCE(NULLIF(split_part(o.external_id, '::', 2), '')::int, 0) AS parallel_id,
         o.serial_number, e.circulation_count, (o.price_cents::numeric / 100) AS price_usd,
         o.seller_address, COALESCE(e.player_name, e.team_name) AS player_name, e.set_name,
         COALESCE(o.ev_tier, e.tier::text) AS moment_tier, e.series AS series_number,
         false AS is_locked, NULL::text AS asset_path_prefix, o.last_seen_at AS ingested_at, o.listed_at
    FROM _open24 o
    JOIN public.editions e ON e.id = o.rpc_edition_id
   WHERE e.circulation_count IS NOT NULL
   ORDER BY o.nft_id, o.listed_at DESC NULLS LAST;
  SELECT count(*) INTO v_n FROM _tsl_want;
  -- Counted on the same slim book every tick (cheap, unlike the two sampled stocks above).
  SELECT count(DISTINCT o.nft_id) INTO v_nocirc
    FROM _open24 o
    JOIN public.editions e ON e.id = o.rpc_edition_id
   WHERE e.circulation_count IS NULL;

  -- Gone: rows no longer in the wanted set (sold, cancelled by a verify read, aged out of the window,
  -- or superseded by a newer listing of the same Moment — the newer one's listing_id replaces it).
  DELETE FROM public.ts_listings t WHERE NOT EXISTS (SELECT 1 FROM _tsl_want w WHERE w.listing_id = t.listing_id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- New and changed. DELTA FIRST: one hash join against ts_listings names the rows that are new
  -- or differ (compared as the target's own column types), and only those reach ON CONFLICT —
  -- which used to probe every one of the ~55k wanted rows to write ~60. The guard on the
  -- conflict arm is unchanged, so the pre-filter can only narrow what is offered, never widen
  -- what is written.
  WITH cand AS (
    SELECT w.*
      FROM _tsl_want w
      LEFT JOIN public.ts_listings t ON t.listing_id = w.listing_id
     WHERE t.listing_id IS NULL
        OR (t.flow_id, t.set_id, t.play_id, t.parallel_id, t.serial_number, t.circulation_count, t.price_usd,
            t.seller_address, t.player_name, t.set_name, t.moment_tier, t.series_number, t.is_locked,
            t.asset_path_prefix, t.ingested_at, t.listed_at)
           IS DISTINCT FROM
           (w.flow_id, w.set_id::integer, w.play_id::integer, w.parallel_id::integer, w.serial_number::integer,
            w.circulation_count::integer, w.price_usd::numeric(12,4), w.seller_address, w.player_name, w.set_name,
            w.moment_tier, w.series_number::integer, w.is_locked::boolean, w.asset_path_prefix,
            w.ingested_at::timestamptz, w.listed_at::timestamptz)
  ), up AS (
    INSERT INTO public.ts_listings (listing_id, flow_id, set_id, play_id, parallel_id, serial_number, circulation_count, price_usd,
                                    seller_address, player_name, set_name, moment_tier, series_number, is_locked, asset_path_prefix,
                                    ingested_at, listed_at)
    SELECT w.listing_id, w.flow_id, w.set_id, w.play_id, w.parallel_id, w.serial_number, w.circulation_count, w.price_usd,
           w.seller_address, w.player_name, w.set_name, w.moment_tier, w.series_number, w.is_locked, w.asset_path_prefix,
           w.ingested_at, w.listed_at
      FROM cand w
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
                            'unverified_24h', v_unverified, 'unmapped', v_unmapped, 'diag_sampled', p_diag,
                            'no_circulation', v_nocirc,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

REVOKE ALL ON FUNCTION public.sync_ts_listings_from_atlas(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ts_listings_from_atlas(boolean) TO service_role;

DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'sync_ts_listings_from_atlas' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'sync_ts_listings_from_atlas must resolve to exactly one function after this migration';
  END IF;
  IF position('circulation_count IS NOT NULL' in (SELECT prosrc FROM pg_proc WHERE oid = 'public.sync_ts_listings_from_atlas(boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'stub-edition filter missing after this migration';
  END IF;
END $post$;
