-- audit_20260918_atlas_listing_syncs_scan_the_open_book_once_per_tick
--
-- R101 (deep-audit register, 2026-09-18): `rpc-ts-listings-atlas-sync` (every 2 min) loses
-- ticks to `statement_timeout` — 58.6% of them in the saturation spell before the #122
-- outage, 5.1% after the restart — and a killed tick is a FUNCTION cancel, so the whole
-- tick's work rolls back and `pipeline_runs` never sees it. Measured 2026-09-18 ~6:3x PM PT
-- (EXPLAIN ANALYZE, BUFFERS, on the tick's own statements):
--
--   * the open-book build (open nba listings seen in 24 h, joined to map + editions,
--     DISTINCT ON nft): 59k rows, ~53,000 buffers of which ~6,000-9,700 are cold heap reads,
--     an EXTERNAL MERGE SORT on disk (10.8 MB temp written AND read back) — 2.6-4.1 s warm.
--     The tick built this SAME set THREE times: `_tsl_want`, `_cl_want`, and the
--     edition_offers floor. ~160,000 buffers and ~65 MB of temp IO per tick, 720 ticks/day.
--   * two DIAGNOSTIC counts in sync_ts_listings (`unverified_24h`, `unmapped`): 18,158 and
--     33,206 buffers per tick (index-only scans over the 395k-row open book, with 5,700 /
--     7,200 heap fetches), returning a slow-moving stock and a constant 0 — every 2 minutes.
--   * baseline over the last 3 h (83 ticks): tick p50 13.4 s / p95 65 s; the sync step
--     p50 9.3 s / p95 49 s; cached_listings p50 2.3 s; edition_offers p50 0.8 s.
--
-- WHAT CHANGES (behaviour-preserving by construction, see each function):
--   1. sync_ts_listings_from_atlas builds the open book ONCE into `_open24` (raw rows, every
--      column any of the three consumers reads) and derives `_tsl_want` from it — the same
--      DISTINCT ON over the same inner joins and predicate, so the same rows.
--   2. sync_cached_listings_from_atlas and sync_edition_offers_from_atlas read `_open24` WHEN
--      IT EXISTS in the transaction (the tick) and fall back to their previous base-table
--      statements verbatim when it does not (a standalone call, the DB-invariant pin tests).
--      The floor keeps its own predicate (the external_id shape) and its own ordering.
--   3. The two diagnostic counts are SAMPLED: `sync_ts_listings_from_atlas(p_diag boolean
--      DEFAULT true)`; the tick passes true twice an hour (minute 0 and 30) and false
--      otherwise. Unsampled ticks publish `unverified_24h` / `unmapped` as NULL with
--      `diag_sampled = false` — a value that was not measured is null, never 0.
--      Standalone calls (and the pin test) keep the default and keep both counts.
--   4. `work_mem = '48MB'` on the three sync functions (an attached SET on a FUNCTION is
--      fine — no transaction control here), so the 59k-row DISTINCT ON sorts in memory
--      (measured: quicksort 12.7 MB) instead of writing and re-reading a temp file on the
--      one resource this database is short of (disk IO).
--
-- What this does NOT change: the wanted set, the differential upsert, the DELETE of gone
-- rows, the floor semantics, the verify/dispatch lanes, any schedule. `ts_listings`,
-- `cached_listings` and `edition_offers` receive byte-identical writes for the same events.
--
-- FULL-BODY WRITES: all four live definitions were re-read (pg_get_functiondef) immediately
-- before this applied; the previous versions are 20260907135757 (sync_ts_listings),
-- 20260907021459 (sync_cached_listings), 20260907024130 (sync_edition_offers) and
-- 20260908035519 (the tick). Signature change: sync_ts_listings_from_atlas() is DROPPED and
-- recreated as (p_diag boolean DEFAULT true) so the 0-arg call keeps resolving to ONE function.
--
-- REVERT: re-apply the four bodies from the migrations named above, then
--         ALTER FUNCTION public.sync_ts_listings_from_atlas(boolean) RESET work_mem; (etc.)
--         — or simply `git revert` this file's commit and re-apply those four bodies.
-- anon-exec: sync_ts_listings_from_atlas (REVOKED from PUBLIC/anon/authenticated below; service_role only, as before)
-- anon-exec: sync_cached_listings_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)
-- anon-exec: sync_edition_offers_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)
-- anon-exec: atlas_listing_verify_tick (REVOKED below — already false live, restated because a snapshot must say so)

DROP FUNCTION IF EXISTS public.sync_ts_listings_from_atlas();

CREATE OR REPLACE FUNCTION public.sync_ts_listings_from_atlas(p_diag boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_ins int; v_upd int; v_del int; v_unverified int; v_unmapped int;
BEGIN
  -- Diagnostics: open nba listings we could not map to an edition are counted, never guessed
  -- at, and listings the verify probes have not re-seen in 24 h are counted the same way.
  -- Both are slow-moving stocks read off a 395k-row index (18k + 33k buffers per read), so
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

  -- The open book, built ONCE per transaction: every open, verified-in-24h, mapped nba listing
  -- with a price, carrying every column the three consumers of this set read. Raw rows — one
  -- Moment may carry several (a relisted Moment keeps its superseded listing "open" until the
  -- verify probe flips it); each consumer applies its own DISTINCT ON / ordering below.
  DROP TABLE IF EXISTS _open24;  -- a caller may run the sync twice in one transaction (the pin does)
  CREATE TEMP TABLE _open24 ON COMMIT DROP AS
  SELECT ev.uuid, ev.nft_id, ev.atlas_edition_id, ev.set_id_onchain, ev.play_id_onchain, ev.serial_number,
         ev.price_cents, ev.seller_address, ev.tier AS ev_tier, ev.listed_at, ev.last_seen_at, ev.listing_resource_id,
         m.external_id, m.rpc_edition_id,
         e.circulation_count, e.player_name, e.team_name, e.set_name, e.tier::text AS edition_tier, e.series, e.thumbnail_url
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
    JOIN public.editions e ON e.id = m.rpc_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours';

  -- The wanted set. One row per Moment: the NEWEST listing per nft wins.
  DROP TABLE IF EXISTS _tsl_want;
  CREATE TEMP TABLE _tsl_want ON COMMIT DROP AS
  SELECT DISTINCT ON (o.nft_id)
         o.uuid AS listing_id, o.nft_id AS flow_id, o.set_id_onchain AS set_id, o.play_id_onchain AS play_id,
         COALESCE(NULLIF(split_part(o.external_id, '::', 2), '')::int, 0) AS parallel_id,
         o.serial_number, o.circulation_count, (o.price_cents::numeric / 100) AS price_usd,
         o.seller_address, COALESCE(o.player_name, o.team_name) AS player_name, o.set_name,
         COALESCE(o.ev_tier, o.edition_tier) AS moment_tier, o.series AS series_number,
         false AS is_locked, NULL::text AS asset_path_prefix, o.last_seen_at AS ingested_at, o.listed_at
    FROM _open24 o
   ORDER BY o.nft_id, o.listed_at DESC NULLS LAST;
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
                            'unverified_24h', v_unverified, 'unmapped', v_unmapped, 'diag_sampled', p_diag,
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
  IF to_regclass('pg_temp._open24') IS NOT NULL THEN
    -- Inside the tick: the open book was built once by sync_ts_listings_from_atlas. Same rows,
    -- same DISTINCT ON, same ordering as the base-table statement below — read, not rebuilt.
    CREATE TEMP TABLE _cl_want ON COMMIT DROP AS
    SELECT DISTINCT ON (o.nft_id)
           o.uuid AS id, o.nft_id AS flow_id, o.external_id AS moment_id,
           COALESCE(o.player_name, o.team_name) AS player_name, o.team_name, o.set_name,
           CASE WHEN o.series IS NULL THEN NULL ELSE 'Series ' || o.series END AS series_name,
           upper(COALESCE(o.ev_tier, o.edition_tier)) AS tier,
           o.serial_number, o.circulation_count, (o.price_cents::numeric / 100) AS ask_price,
           'https://nbatopshot.com/moment/' || o.nft_id AS buy_url, o.thumbnail_url,
           o.listing_resource_id, o.seller_address AS storefront_address, o.listed_at, o.last_seen_at AS cached_at
      FROM _open24 o
     ORDER BY o.nft_id, o.listed_at DESC NULLS LAST;
  ELSE
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
  END IF;
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
  IF to_regclass('pg_temp._open24') IS NOT NULL THEN
    -- Inside the tick: the floor is read off the open book sync_ts_listings_from_atlas built.
    -- Same rows (raw, not per-Moment deduplicated), same extra predicate, same ordering.
    WITH floor AS (
      SELECT DISTINCT ON (o.external_id)
             o.external_id, (o.price_cents::numeric / 100) AS low_ask, o.serial_number, o.nft_id
        FROM _open24 o
       WHERE o.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY o.external_id, o.price_cents ASC, o.serial_number ASC NULLS LAST
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
  ELSE
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
  END IF;

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_settle jsonb; v_sync jsonb; v_cl jsonb; v_eo jsonb; v_disp jsonb; v_edisp jsonb; v_err text;
BEGIN
  BEGIN
    v_settle := public.atlas_edition_verify_settle();
    -- The two 395k-row diagnostic counts run twice an hour (the :00 and :30 ticks), not every
    -- 2 minutes; the other ticks publish them as NULL with diag_sampled = false.
    v_sync := public.sync_ts_listings_from_atlas((extract(minute from clock_timestamp())::int % 30) < 2);
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

-- The 59k-row DISTINCT ON sorts in memory instead of on the saturated disk (measured 12.7 MB).
ALTER FUNCTION public.sync_ts_listings_from_atlas(boolean) SET work_mem = '48MB';
ALTER FUNCTION public.sync_cached_listings_from_atlas() SET work_mem = '48MB';
ALTER FUNCTION public.sync_edition_offers_from_atlas() SET work_mem = '48MB';

REVOKE ALL ON FUNCTION public.sync_ts_listings_from_atlas(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_cached_listings_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_listing_verify_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ts_listings_from_atlas(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_cached_listings_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_edition_offers_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_listing_verify_tick(int) TO service_role;
