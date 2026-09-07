-- audit_20260907: the two Atlas listing syncs become DIFFERENTIAL — the whole open book was being deleted and re-inserted every 2 minutes.
--
-- WHAT THE WATCH READ. `ts-listings-atlas-sync` `duration_ms` by hour (2026-09-07): 2.7 s (04Z) → 1.4 → 4.2 → 1.2 →
-- 1.3 → 1.7 → 2.1 → 4.6 → **9.3 s (13Z, max 112 s)** as the open set grew 1,894 → 14,944 rows — the
-- firehose sees ~8K events/hour and a listing stays "open + verified in 24 h" until it sells or the
-- window closes, so the set is still filling toward a day's listing volume. pg_stat_statements for
-- `SELECT public.atlas_listing_verify_tick(2)`: 354 calls, **4,033 MB of WAL (11.4 MB/call, rising),
-- 353K buffers/call**. Both `sync_ts_listings_from_atlas()` (pinned) and
-- `sync_cached_listings_from_atlas()` did `DELETE <everything>; INSERT <everything>` — 15K rows
-- deleted and re-inserted, with their indexes, 30 times an hour, for a set that changes by a few
-- hundred rows a tick. The #35 shape, one day old.
--
-- THE CHANGE. Each sync computes the SAME wanted set (byte-identical SELECT … DISTINCT ON) into a
-- temp table, then: deletes rows no longer wanted; inserts new ones; updates an existing row ONLY
-- when a carried column actually changed (`IS DISTINCT FROM` on the row). Output is identical
-- (the pin's assertions are unchanged and it runs the second sync as the idempotence proof; two
-- assertions added — a second sync must report 0 inserted / 0 deleted / 0 updated). `rows` in the
-- payload keeps meaning the size of the open set (the watch reads it); `inserted`/`updated`/
-- `deleted` are added beside it. `cached_listings.cached_at` now carries the event's
-- `last_seen_at` (the listing's actual freshness) instead of `now()` — stable rows no longer
-- rewrite it every tick; membership already requires `last_seen_at > now() - 24 h`, so the 48-h
-- `purge-stale-listings` cutoff can never reach a live row. The Flowty rows sharing a `flow_id`
-- stay untouched: the update arm is restricted to `source = 'topshot'`.
--
-- Measured on the first live ticks after apply (numbers in the 2026-09-06 ledger entry): the
-- wanted-set SELECT costs what the old INSERT's SELECT cost; the diff touches the rows that changed
-- instead of 2 × the open set.
--
-- Pin: supabase/tests/sync_ts_listings_from_atlas.sql (verbatim block re-pinned to THIS file);
-- __tests__/db-invariants-drift-guard.test.ts registration moved to THIS file.
--
-- REVERT: re-apply both bodies from 20260907020428 / 20260907021459 (delete-then-insert), move the pin back.

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
-- anon-exec: intentional — same signature as 20260907020428, ACLs preserved (sync_ts_listings_from_atlas)

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
-- anon-exec: intentional — same signature as 20260907021459, ACLs preserved (sync_cached_listings_from_atlas)
