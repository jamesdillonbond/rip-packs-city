-- audit_20260919_r101_v2_atlas_listing_tick_scans_the_open_book_once_and_upserts_only_the_delta
--
-- R101 v2 (deep-audit register). The 09-18 R101 ship (`20260919012821`) was REVERTED 42 minutes
-- later (`20260919021449`) under an estate-wide IO spell that was later RULED OUT as its doing
-- (ledger 2026-09-18, "R101 REVERTED"). That entry left the conditions for bringing the design
-- back: slim `_open24` (keep rpc_edition_id, re-join editions per consumer), NO per-tick memory
-- grants, and a measurement against the tick's own instrument. This is that, plus one more cut
-- the first version did not take.
--
-- MEASURED 2026-09-19 ~8:10 AM PT, under load (io_wait 14 / active 15), on the tick's own
-- statements (EXPLAIN ANALYZE, BUFFERS) and on pg_stat_statements for the tick itself:
--   * the tick (`SELECT public.atlas_listing_verify_tick($1)`, queryid -3354316985779850203):
--     6,951 calls since the 08-12 reset, 927,297 shared buffers PER CALL (~7.2 GB touched every
--     2 minutes), mean 18.2 s, 4.0k temp blocks written per call. It is the #3 physical reader
--     on the instance (1,402 GB). cron.job_run_details for jobid 466 over 24 h: 580 runs, 191
--     failed (33%), 31,318 worker-seconds — the largest job on the box by worker time.
--   * the open-book build (open nba listings seen in 24 h + map + editions, DISTINCT ON nft):
--     55,118 rows, 50,067 buffers (2,179 cold), external merge sort 10 MB on disk, 32.2 s under
--     load. Built TWICE per tick (`_tsl_want`, `_cl_want`) and a third time as the floor.
--   * the two diagnostic counts (`unmapped`, `unverified_24h`): 41,863 + 23,448 buffers per tick
--     for a constant 0 and a slow-moving stock (341k), every 2 minutes.
--   * the sync legs are ~95% of the tick: pipeline_runs.extra 13:43–15:02Z, sync 3–65 s,
--     cached_listings 2–43 s, edition_offers 0.2–25 s, remainder 3–5 s.
--   * WHERE THE REST OF THE 927k BUFFERS GO: both upserts push the WHOLE wanted set (~55k rows)
--     through `INSERT … ON CONFLICT DO UPDATE … WHERE (row) IS DISTINCT FROM (EXCLUDED row)`.
--     ON CONFLICT resolves per row — one unique-index probe plus one heap fetch each — so the
--     differential guard, which correctly writes ~60 rows a tick, still PROBES 55k rows a tick,
--     twice (ts_listings, cached_listings), plus ~14k for the edition_offers floor.
--     `ts_listings` is 14 MB (1.8k pages) and `cached_listings` 50 MB (6.4k pages): reading each
--     ONCE in a hash join is an order of magnitude cheaper than 55k index probes into it.
--   * EQUIVALENCE, PROVEN ON PROD DATA READ-ONLY before this applied: the `_open24`-derived
--     wanted set = 55,655 rows, the base-table set = 55,655, EXCEPT = 0; the pre-filter offers
--     538 new + 187 changed = 725 rows to ON CONFLICT (was 55,655); the cast and uncast row
--     comparisons agree (187 = 187).
--
-- WHAT CHANGES (behaviour-preserving by construction):
--   1. `sync_ts_listings_from_atlas(p_diag boolean DEFAULT true)` builds `_open24` ONCE per
--      transaction as the common core of all three consumers — `topshot_atlas_market_events`
--      JOIN `topshot_atlas_edition_map` under the shared predicate, the ev/map columns only. Each
--      consumer then applies exactly what it applied before: `_tsl_want` / `_cl_want` inner-join
--      `editions` and DISTINCT ON (nft_id) newest-first; the floor keeps its external_id shape
--      predicate and its own ordering and never joined editions. Same rows, same order, same set.
--   2. `sync_cached_listings_from_atlas()` and `sync_edition_offers_from_atlas()` read `_open24`
--      when it exists in the transaction and fall back to their previous base-table statements
--      VERBATIM otherwise (standalone calls, the DB-invariant pins).
--   3. The two diagnostic counts are SAMPLED (`p_diag`): the tick passes true at minutes 0/1 and
--      30/31, false otherwise. An unsampled tick publishes `unverified_24h` / `unmapped` as NULL
--      with `diag_sampled = false` — a value that was not measured is null, never 0. Standalone
--      calls keep the default and keep both counts.
--   4. DELTA-FIRST UPSERTS. Each upsert now feeds ON CONFLICT only the rows a LEFT JOIN against
--      the target says are NEW or DIFFERENT (the same column tuple, compared IS DISTINCT FROM
--      with the target's own column types). The ON CONFLICT … WHERE guard is kept verbatim, so
--      a row that passes the pre-filter still writes only if the guard agrees — the pre-filter
--      can only narrow the rows offered, never widen what is written. Identical rows (the
--      common case) are neither probed nor returned, exactly as before; `inserted`/`updated`
--      keep their meaning (RETURNING xmax = 0 on the rows actually written).
--      For cached_listings the pre-filter also carries the `source = 'topshot'` restriction of
--      the update arm, so a Flowty-owned flow_id is skipped rather than probed-then-skipped.
--   5. No `work_mem` / `temp_buffers` grants (the 09-18 lesson). The sort still spills ~10 MB;
--      that is one write+read of a temp file per build, and the build now happens once.
--
-- What this does NOT change: the wanted set, the DELETE of gone rows, the floor semantics, the
-- evidence-based NULL, the highest_offer arm, the verify/dispatch lanes, any schedule or grant.
-- `ts_listings`, `cached_listings` and `edition_offers` receive byte-identical writes.
--
-- MEASUREMENT CONTRACT (same instrument both sides, split on this migration's apply time):
--   pg_stat_statements for queryid -3354316985779850203 — (shared_blks_hit + shared_blks_read)
--   per call, cumulative BEFORE = 927,297 (6,951 calls). Read the delta after ≥30 ticks. The
--   no-change controls are `rpc-atlas-market-drain` (463) and `rpc-allday-unmapped-atlas-resolver`
--   (464) on cron.job_run_details, same window. FALSIFIER: buffers/call not down ≥40% on the
--   post-apply delta with the controls flat ⇒ the cost model above is wrong; revert.
--
-- FULL-BODY WRITES: all four live prosrc md5s were read immediately before this applied and
-- equal the bodies in 20260919021449 (ae2077e9…, f76e9d82…, 3e348706…, 427077bc…); the guard
-- below RAISEs if any has moved since.
-- Signature change: sync_ts_listings_from_atlas() is DROPPED and recreated as
-- (p_diag boolean DEFAULT true) so the 0-arg call keeps resolving to ONE function.
--
-- REVERT: re-apply the four bodies from 20260919021449 (DROP FUNCTION public.sync_ts_listings_from_atlas(boolean)
--         first, then its 0-arg CREATE), then re-point the two PINS entries and pin copies back to it.
-- anon-exec: sync_ts_listings_from_atlas (REVOKED from PUBLIC/anon/authenticated below; service_role only, as before)
-- anon-exec: sync_cached_listings_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)
-- anon-exec: sync_edition_offers_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)
-- anon-exec: atlas_listing_verify_tick (REVOKED below — already false live, restated because a snapshot must say so)

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sync_ts_listings_from_atlas' AND pronamespace = 'public'::regnamespace) <> 'ae2077e9d1764e47e5c3d2a1a4baef86' THEN
    RAISE EXCEPTION 'sync_ts_listings_from_atlas live body is not the 20260919021449 one — re-read before a full-body write';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sync_cached_listings_from_atlas' AND pronamespace = 'public'::regnamespace) <> 'f76e9d8215f82e445296102bce91465f' THEN
    RAISE EXCEPTION 'sync_cached_listings_from_atlas live body is not the 20260919021449 one';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sync_edition_offers_from_atlas' AND pronamespace = 'public'::regnamespace) <> '3e34870620c72c6dc74f734fbaf502e6' THEN
    RAISE EXCEPTION 'sync_edition_offers_from_atlas live body is not the 20260919021449 one';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'atlas_listing_verify_tick' AND pronamespace = 'public'::regnamespace) <> '427077bc84bd6c4c5cf67af4724cffaa' THEN
    RAISE EXCEPTION 'atlas_listing_verify_tick live body is not the 20260919021449 one';
  END IF;
END $guard$;

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

  -- The wanted set. One row per Moment: the NEWEST listing per nft wins.
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
   ORDER BY o.nft_id, o.listed_at DESC NULLS LAST;
  SELECT count(*) INTO v_n FROM _tsl_want;

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
    -- same editions join, same DISTINCT ON, same ordering as the base-table statement below.
    CREATE TEMP TABLE _cl_want ON COMMIT DROP AS
    SELECT DISTINCT ON (o.nft_id)
           o.uuid AS id, o.nft_id AS flow_id, o.external_id AS moment_id,
           COALESCE(e.player_name, e.team_name) AS player_name, e.team_name, e.set_name,
           CASE WHEN e.series IS NULL THEN NULL ELSE 'Series ' || e.series END AS series_name,
           upper(COALESCE(o.ev_tier, e.tier::text)) AS tier,
           o.serial_number, e.circulation_count, (o.price_cents::numeric / 100) AS ask_price,
           'https://nbatopshot.com/moment/' || o.nft_id AS buy_url, e.thumbnail_url,
           o.listing_resource_id, o.seller_address AS storefront_address, o.listed_at, o.last_seen_at AS cached_at
      FROM _open24 o
      JOIN public.editions e ON e.id = o.rpc_edition_id
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

  -- New and changed. DELTA FIRST (see sync_ts_listings_from_atlas): one hash join against
  -- cached_listings names the rows that are new, or are OURS ('topshot') and differ; only those
  -- reach ON CONFLICT. A flow_id already held by a Flowty row is left to Flowty — before, it was
  -- probed and then skipped by the guard; now it is skipped by the pre-filter. The guard is kept.
  WITH cand AS (
    SELECT w.*
      FROM _cl_want w
      LEFT JOIN public.cached_listings c ON c.flow_id = w.flow_id
     WHERE c.flow_id IS NULL
        OR (c.source = 'topshot'
            AND (c.id, c.moment_id, c.player_name, c.team_name, c.set_name, c.series_name, c.tier, c.serial_number,
                 c.circulation_count, c.ask_price, c.buy_url, c.thumbnail_url, c.listing_resource_id,
                 c.storefront_address, c.listed_at, c.cached_at)
                IS DISTINCT FROM
                (w.id, w.moment_id, w.player_name, w.team_name, w.set_name, w.series_name, w.tier,
                 w.serial_number::integer, w.circulation_count::integer, w.ask_price::numeric, w.buy_url, w.thumbnail_url,
                 w.listing_resource_id, w.storefront_address, w.listed_at::timestamptz, w.cached_at::timestamptz))
  ), up AS (
    INSERT INTO public.cached_listings (id, flow_id, moment_id, player_name, team_name, set_name, series_name, tier,
                                        serial_number, circulation_count, ask_price, fmv, source, buy_url, thumbnail_url,
                                        listing_resource_id, storefront_address, is_locked, listed_at, cached_at, collection_id)
    SELECT w.id, w.flow_id, w.moment_id, w.player_name, w.team_name, w.set_name, w.series_name, w.tier,
           w.serial_number, w.circulation_count, w.ask_price, NULL, 'topshot', w.buy_url, w.thumbnail_url,
           w.listing_resource_id, w.storefront_address, false, w.listed_at, w.cached_at,
           '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      FROM cand w
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
  -- The floor: lowest open ask per edition. DELTA FIRST — the floor is compared against
  -- edition_offers in one join and only new/changed editions reach ON CONFLICT; the guard on
  -- the conflict arm is unchanged. Inside the tick the floor is read off the open book
  -- sync_ts_listings_from_atlas built (same raw rows — the floor never joined editions — same
  -- extra predicate, same ordering); standalone it reads the base tables as before.
  IF to_regclass('pg_temp._open24') IS NOT NULL THEN
    WITH floor AS (
      SELECT DISTINCT ON (o.external_id)
             o.external_id, (o.price_cents::numeric / 100) AS low_ask, o.serial_number, o.nft_id
        FROM _open24 o
       WHERE o.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY o.external_id, o.price_cents ASC, o.serial_number ASC NULLS LAST
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE eo.external_id IS NULL
          OR eo.low_ask IS DISTINCT FROM f.low_ask::numeric
          OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
        FROM cand f
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
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE eo.external_id IS NULL
          OR eo.low_ask IS DISTINCT FROM f.low_ask::numeric
          OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
        FROM cand f
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
    -- The two ~400k-row diagnostic counts run twice an hour (the :00/:01 and :30/:31 ticks), not
    -- every 2 minutes; the other ticks publish them as NULL with diag_sampled = false.
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

REVOKE ALL ON FUNCTION public.sync_ts_listings_from_atlas(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_cached_listings_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_listing_verify_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ts_listings_from_atlas(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_cached_listings_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_edition_offers_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_listing_verify_tick(int) TO service_role;

-- Post-conditions: the signature swap resolved to exactly one function, and no arg-less stump remains.
DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'sync_ts_listings_from_atlas' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'sync_ts_listings_from_atlas must resolve to exactly one function after this migration';
  END IF;
  IF to_regprocedure('public.sync_ts_listings_from_atlas(boolean)') IS NULL THEN
    RAISE EXCEPTION 'sync_ts_listings_from_atlas(boolean) missing after this migration';
  END IF;
END $post$;
