-- audit_20260907: an EDITION verify lane — stale Top Shot asks are NULLed on evidence, and
-- highest_offer comes from Atlas for editions verified within 24 h.
--
-- WHY. After 20260907022120, `edition_offers.low_ask` is live for the ~524 editions Atlas has an
-- open listing for and STALE (pre-08-28, dead GQL sweep) for the other ~11.7K — a "lowest ask"
-- with no open listing behind it. And `highest_offer` had no Atlas path at all, because offer
-- withdrawals are not in the firehose. Measured 02:35Z (probe `__probe__ do edition histories
-- carry offers`): `{product, editionId}` returns the edition's history WITH its offers and their
-- completion state — one read verifies both the open book and the open offers of an edition
-- (its newest 200 rows; `pagination.totalCount` says whether that is all of them).
--
-- MECHANISM.
--  * atlas_edition_verify_dispatch(p_max): each tick reads up to p_max editions as
--    {product:'nba', editionId} — stalest first, where "stale" is the OLDEST of the edition's
--    edition_offers.updated_at and the last_seen_at of its open offers/listings. Requests are
--    recorded offset_at = -4, error '__edition__<atlasId>'. 2 per 2-min tick = 1 req/min; the
--    ~12K Top Shot editions with an edition_offers row cycle in ~8 days, editions with open
--    offers/listings much sooner because they sort first.
--  * atlas_edition_verify_settle(): for each drained 200 request not yet settled (offset_at -4
--    → -5): records topshot_atlas_edition_verified(atlas_edition_id, verified_at, complete) and,
--    when the page was COMPLETE (totalCount ≤ 200 — read back from net._http_response), marks
--    every open listing/offer of that edition NOT seen by the read (last_seen_at < dispatched_at)
--    as completed: Atlas no longer lists it. An INCOMPLETE page verifies only what it contained.
--  * sync_edition_offers_from_atlas(): unchanged for low_ask where an open listing exists; NOW
--    ALSO (a) NULLs low_ask/low_ask_serial/low_ask_nft_id for an edition verified COMPLETE within
--    24 h that has NO open listing (evidence, not age), and (b) writes highest_offer = MAX open
--    EDITION/PARALLEL offer for editions verified within 24 h (NULL when verified complete and
--    none is open). highest_offer is otherwise left to its existing on-chain path.
--  * atlas_listing_verify_tick(): settle → syncs → listing verify (2) → edition verify (2).
--    Atlas budget: firehose ~1 + All Day resolver ~2 + listing verify 1 + edition verify 1
--    ≈ 5 req/min, the measured comfortable rate.
--
-- REVERT: SELECT cron.schedule('rpc-ts-listings-atlas-sync','*/2 * * * *','SELECT public.atlas_listing_verify_tick(3)')
--   with the tick body from 20260907022120; DROP FUNCTION public.atlas_edition_verify_dispatch(int),
--   public.atlas_edition_verify_settle(); DROP TABLE public.topshot_atlas_edition_verified;
--   re-apply sync_edition_offers_from_atlas from 20260907022120.

CREATE TABLE IF NOT EXISTS public.topshot_atlas_edition_verified (
  atlas_edition_id text PRIMARY KEY,
  verified_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  open_listings int,
  open_offers int
);
-- RLS was NOT in the applied copy of this migration; check_public_security_invariants() flagged
-- it (rls_off_base_table) and 20260907024159 enabled it 29 s later. Kept here so the file states
-- the table's whole contract; re-applying it is idempotent.
ALTER TABLE public.topshot_atlas_edition_verified ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_atlas_edition_verified FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.topshot_atlas_edition_verified TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_dispatch(p_max int DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; v_req bigint; v_n int := 0;
BEGIN
  FOR r IN
    WITH cand AS (
      -- editions with an edition_offers row (the readers' surface) …
      SELECT m.atlas_edition_id, eo.updated_at AS stale_at
        FROM public.edition_offers eo
        JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
       WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      UNION ALL
      -- … and editions carrying an open offer or listing in our events
      SELECT ev.atlas_edition_id, min(ev.last_seen_at)
        FROM public.topshot_atlas_market_events ev
       WHERE ev.product = 'nba' AND NOT ev.completed AND ev.atlas_edition_id IS NOT NULL
       GROUP BY ev.atlas_edition_id
    )
    SELECT c.atlas_edition_id, min(c.stale_at) AS stale_at
      FROM cand c
      LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = c.atlas_edition_id
     WHERE c.atlas_edition_id IS NOT NULL
       AND (v.verified_at IS NULL OR v.verified_at < now() - interval '24 hours')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q
                        WHERE q.error = '__edition__' || c.atlas_edition_id AND q.drained_at IS NULL
                          AND q.dispatched_at > now() - interval '10 minutes')
     GROUP BY c.atlas_edition_id, v.verified_at
     ORDER BY COALESCE(v.verified_at, '-infinity'::timestamptz) ASC, min(c.stale_at) ASC NULLS FIRST
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
    VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.atlas_edition_verify_settle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE q record; v_total int; v_complete boolean; v_settled int := 0; v_closed int := 0; v_n int;
BEGIN
  FOR q IN
    SELECT a.request_id, a.dispatched_at, substr(a.error, length('__edition__') + 1) AS atlas_edition_id, a.rows_upserted,
           (r0.content::jsonb->'pagination'->>'totalCount')::int AS total_count
      FROM public.topshot_atlas_market_requests a
      LEFT JOIN net._http_response r0 ON r0.id = a.request_id
     WHERE a.offset_at = -4 AND a.drained_at IS NOT NULL AND a.status_code = 200
       AND a.error LIKE '\_\_edition\_\_%'
     ORDER BY a.dispatched_at
     LIMIT 20
  LOOP
    v_total := q.total_count;
    v_complete := v_total IS NOT NULL AND v_total <= 200;
    IF v_complete THEN
      UPDATE public.topshot_atlas_market_events ev
         SET completed = true
       WHERE ev.product = 'nba' AND ev.atlas_edition_id = q.atlas_edition_id
         AND NOT ev.completed AND ev.last_seen_at < q.dispatched_at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_closed := v_closed + v_n;
    END IF;
    INSERT INTO public.topshot_atlas_edition_verified (atlas_edition_id, verified_at, complete, open_listings, open_offers)
    VALUES (q.atlas_edition_id, q.dispatched_at, v_complete,
            (SELECT count(*) FROM public.topshot_atlas_market_events e2 WHERE e2.product='nba' AND e2.atlas_edition_id = q.atlas_edition_id AND e2.kind='listing' AND NOT e2.completed),
            (SELECT count(*) FROM public.topshot_atlas_market_events e2 WHERE e2.product='nba' AND e2.atlas_edition_id = q.atlas_edition_id AND e2.kind='offer' AND NOT e2.completed))
    ON CONFLICT (atlas_edition_id) DO UPDATE
      SET verified_at = EXCLUDED.verified_at, complete = EXCLUDED.complete,
          open_listings = EXCLUDED.open_listings, open_offers = EXCLUDED.open_offers;
    UPDATE public.topshot_atlas_market_requests SET offset_at = -5 WHERE request_id = q.request_id;
    v_settled := v_settled + 1;
  END LOOP;
  RETURN jsonb_build_object('settled', v_settled, 'closed', v_closed);
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

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max int DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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
    v_edisp := public.atlas_edition_verify_dispatch(2);
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

REVOKE ALL ON FUNCTION public.atlas_edition_verify_dispatch(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_edition_verify_settle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_edition_verify_dispatch(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_edition_verify_settle() TO service_role;
-- anon-exec: intentional — same signatures as 20260907022120, ACLs preserved (sync_edition_offers_from_atlas, atlas_listing_verify_tick)

SELECT cron.schedule('rpc-ts-listings-atlas-sync', '*/2 * * * *', 'SELECT public.atlas_listing_verify_tick(2)');
