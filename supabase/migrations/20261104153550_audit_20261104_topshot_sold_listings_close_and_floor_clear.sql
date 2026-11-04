-- audit_20261104_topshot_sold_listings_close_and_floor_clear
--
-- 2026-11-04 ~8 AM PT (Cowork cloud; Trevor: "How can we make sure asks are up to date?" -> "Do it all").
--
-- MEASURED BEFORE (7:15 AM PT): of 13,794 Top Shot edition_offers rows with a low_ask, 1,933 (14 %) named a floor
-- Moment (low_ask_nft_id) that our own sales table shows SOLD after the ask was last confirmed
-- (sold_at > low_ask_confirmed_at). Not an age effect: 12.4 % of asks confirmed < 24 h ago were already sold.
-- Example: 91:3101 showed $7.37 for serial #709; that exact NFT sold for $7.37 at 6:47 AM PT and the ask stood.
--
-- ROOT CAUSE: topshot_atlas_market_events keeps the listing row completed = false after the Moment sells (the sale
-- reaches `sales` from the on-chain indexer within minutes, but nothing joins it back to the listing). Measured on a
-- 20,000-row sample of open listing events: 782 (3.9 %) belong to an NFT sold after listed_at -> ~16,800 of the
-- 429,223 open events are dead. The floor builder (sync_edition_offers_from_atlas) and every open-book reader trust them.
--
-- WHY A SALE AFTER listed_at CLOSES THE LISTING (and cannot close a live one): a listing is the seller's offer of an
-- NFT they hold; once that NFT changes hands the listing cannot fill. A RELIST by the buyer is a NEW listing with
-- listed_at AFTER the sale, so `sold_at > listed_at` never matches it (the 2026-09-19 refuted "deactivate on any
-- sale" matched relists because it ignored listed_at). Same for the floor: an ask confirmed open at time C whose NFT
-- sold at S > C is gone.
--
-- WHAT THIS ADDS (one function, pg_cron at :05 :10 :15 :25 :30 :35 :45 :50 :55 -- a minute before each
-- ts-listings-atlas-sync tick (1-56/5) so a cleared floor is refilled from the corrected book; :00/:20/:40 skipped per
-- the cron stagger rule):
--   1. close open nba listing events whose NFT has a Top Shot sale after listed_at
--        a. every sale in the last 24 h (index probe on idx_tame_nft per sold NFT), and
--        b. a one-time BACKLOG walk over all open listing events by uuid, 10,000 per tick (~43 ticks, ~3.6 h),
--           cursor in topshot_sold_listing_close_state; every closed uuid is recorded in topshot_sold_listing_closes.
--   2. clear the floor: edition_offers.low_ask (+ serial, nft) -> NULL where low_ask_nft_id sold after
--      low_ask_confirmed_at. The edition_offers_stamp_low_ask_confirmed trigger nulls the stamp with it. The old
--      values are kept in topshot_sold_floor_clears. NULL = "unknown until re-observed", the #149 rule.
--   3. re-verify: for cleared editions still NULL, dispatch the same Atlas edition-verify probe the undercut lane uses
--      (offset_at -4, error '__edition__<id>', drained by atlas_market_drain, settled by atlas_edition_verify_settle);
--      the next ts-listings-atlas-sync tick then writes the real floor from the re-observed book. 6 per tick.
--   4. instrument: rpc_trust_health_precompute 'topshot_sold_floor_asks_found' = sold floors found THIS tick (before
--      clearing). Steady state is a handful per tick; a persistently high value means a writer is re-publishing dead
--      floors; a dead job ages the row to 999 via the pre CTE. pipeline 'ts-sold-floor-clear' + a cadence row.
--
-- anon-exec: revoked (close_sold_topshot_listings_and_floors) — REVOKE FROM PUBLIC, anon, authenticated below; service_role + postgres only.
--
-- REVERT: docs/audits/2026-11-04-topshot-sold-floor-clear-revert.sql (unschedule the job, re-open the recorded
-- listing events, restore the recorded asks, drop the objects).

CREATE TABLE IF NOT EXISTS public.topshot_sold_listing_close_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  backlog_cursor text,
  backlog_done_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.topshot_sold_listing_close_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.topshot_sold_listing_closes (
  uuid text PRIMARY KEY,
  nft_id text NOT NULL,
  listed_at timestamptz,
  sold_at timestamptz NOT NULL,
  arm text NOT NULL CHECK (arm IN ('recent', 'backlog', 'floor')),
  closed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.topshot_sold_floor_clears (
  id bigserial PRIMARY KEY,
  external_id text NOT NULL,
  atlas_edition_id text,
  old_low_ask numeric,
  old_low_ask_serial integer,
  old_low_ask_nft_id text,
  old_confirmed_at timestamptz,
  sold_at timestamptz NOT NULL,
  sold_price_usd numeric,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  verify_dispatched_at timestamptz,
  verify_request_id bigint,
  refilled_before_verify boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_sold_floor_clears_pending ON public.topshot_sold_floor_clears (cleared_at)
  WHERE verify_dispatched_at IS NULL AND NOT refilled_before_verify;

ALTER TABLE public.topshot_sold_listing_close_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topshot_sold_listing_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topshot_sold_floor_clears ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_sold_listing_close_state, public.topshot_sold_listing_closes, public.topshot_sold_floor_clears FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.topshot_sold_floor_clears_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.close_sold_topshot_listings_and_floors(p_backlog_batch int DEFAULT 10000, p_verify int DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cid constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_recent int := 0; v_backlog int := 0; v_backlog_scanned int := 0;
  v_found int := 0; v_floor_events int := 0; v_cleared int := 0; v_refilled int := 0; v_dispatched int := 0;
  v_cursor text; v_done timestamptz; v_last text;
  v_err text; r record; v_req bigint;
BEGIN
  BEGIN
    -- 1a. RECENT: every Top Shot sale in the last 24 h closes the seller's earlier open listing of that NFT.
    WITH s AS (
      SELECT x.nft_id, max(x.sold_at) AS sold_at
        FROM public.sales x
       WHERE x.collection_id = v_cid AND x.sold_at > now() - interval '24 hours' AND x.nft_id IS NOT NULL
       GROUP BY x.nft_id
    ), hit AS (
      SELECT ev.uuid, ev.nft_id, ev.listed_at, s.sold_at
        FROM s
        JOIN public.topshot_atlas_market_events ev ON ev.nft_id = s.nft_id
       WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
         AND ev.listed_at < s.sold_at
    ), rec AS (
      INSERT INTO public.topshot_sold_listing_closes (uuid, nft_id, listed_at, sold_at, arm)
      SELECT h.uuid, h.nft_id, h.listed_at, h.sold_at, 'recent' FROM hit h
      ON CONFLICT (uuid) DO NOTHING
      RETURNING uuid
    )
    UPDATE public.topshot_atlas_market_events ev SET completed = true
      FROM hit h WHERE ev.uuid = h.uuid AND NOT ev.completed;
    GET DIAGNOSTICS v_recent = ROW_COUNT;

    -- 1b. BACKLOG (one-time): walk open listing events by uuid, p_backlog_batch per tick.
    SELECT backlog_cursor, backlog_done_at INTO v_cursor, v_done FROM public.topshot_sold_listing_close_state WHERE id = 1;
    IF v_done IS NULL AND p_backlog_batch > 0 THEN
      SELECT count(*), max(b.uuid) INTO v_backlog_scanned, v_last
        FROM (SELECT ev.uuid
                FROM public.topshot_atlas_market_events ev
               WHERE (v_cursor IS NULL OR ev.uuid > v_cursor)
                 AND ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
               ORDER BY ev.uuid
               LIMIT p_backlog_batch) b;

      IF v_backlog_scanned > 0 THEN
        WITH batch AS MATERIALIZED (
          SELECT ev.uuid, ev.nft_id, ev.listed_at
            FROM public.topshot_atlas_market_events ev
           WHERE (v_cursor IS NULL OR ev.uuid > v_cursor) AND ev.uuid <= v_last
             AND ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
        ), hit AS (
          SELECT b.uuid, b.nft_id, b.listed_at, x.sold_at
            FROM batch b
           CROSS JOIN LATERAL (
             SELECT s.sold_at FROM public.sales s
              WHERE s.collection_id = v_cid AND s.nft_id = b.nft_id AND s.sold_at > b.listed_at
              ORDER BY s.sold_at DESC LIMIT 1) x
        ), rec AS (
          INSERT INTO public.topshot_sold_listing_closes (uuid, nft_id, listed_at, sold_at, arm)
          SELECT h.uuid, h.nft_id, h.listed_at, h.sold_at, 'backlog' FROM hit h
          ON CONFLICT (uuid) DO NOTHING
          RETURNING uuid
        )
        UPDATE public.topshot_atlas_market_events ev SET completed = true
          FROM hit h WHERE ev.uuid = h.uuid AND NOT ev.completed;
        GET DIAGNOSTICS v_backlog = ROW_COUNT;
      END IF;

      UPDATE public.topshot_sold_listing_close_state
         SET backlog_cursor = COALESCE(v_last, backlog_cursor),
             backlog_done_at = CASE WHEN v_backlog_scanned < p_backlog_batch THEN now() END,
             updated_at = now()
       WHERE id = 1;
    END IF;

    -- 2. FLOOR: an ask whose exact NFT sold after the ask was last confirmed is gone. One statement: record the old
    -- values, close the floor listing's own event (so the next ts-listings-atlas-sync cannot re-read it as the floor
    -- while the backlog walk has not reached it), and clear the ask -- all from the same materialised set.
    WITH f AS MATERIALIZED (
      SELECT o.external_id, o.low_ask AS old_low_ask, o.low_ask_serial AS old_low_ask_serial,
             o.low_ask_nft_id AS old_low_ask_nft_id, o.low_ask_confirmed_at AS old_confirmed_at,
             x.sold_at, x.price_usd AS sold_price
        FROM public.edition_offers o
       CROSS JOIN LATERAL (
         SELECT s.sold_at, s.price_usd FROM public.sales s
          WHERE s.collection_id = v_cid AND s.nft_id = o.low_ask_nft_id AND s.sold_at > o.low_ask_confirmed_at
          ORDER BY s.sold_at DESC LIMIT 1) x
       WHERE o.collection_id = v_cid AND o.low_ask IS NOT NULL AND o.low_ask_nft_id IS NOT NULL
         AND o.low_ask_confirmed_at IS NOT NULL
    ), evh AS (
      SELECT ev.uuid, ev.nft_id, ev.listed_at, f.sold_at
        FROM f
        JOIN public.topshot_atlas_market_events ev ON ev.nft_id = f.old_low_ask_nft_id
       WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.listed_at < f.sold_at
    ), evrec AS (
      INSERT INTO public.topshot_sold_listing_closes (uuid, nft_id, listed_at, sold_at, arm)
      SELECT evh.uuid, evh.nft_id, evh.listed_at, evh.sold_at, 'floor' FROM evh
      ON CONFLICT (uuid) DO NOTHING
      RETURNING uuid
    ), evup AS (
      UPDATE public.topshot_atlas_market_events ev SET completed = true
        FROM evh WHERE ev.uuid = evh.uuid AND NOT ev.completed
      RETURNING 1
    ), rec AS (
      INSERT INTO public.topshot_sold_floor_clears (external_id, atlas_edition_id, old_low_ask, old_low_ask_serial,
             old_low_ask_nft_id, old_confirmed_at, sold_at, sold_price_usd)
      SELECT f.external_id, m.atlas_edition_id, f.old_low_ask, f.old_low_ask_serial, f.old_low_ask_nft_id,
             f.old_confirmed_at, f.sold_at, f.sold_price
        FROM f
        LEFT JOIN LATERAL (SELECT mm.atlas_edition_id FROM public.topshot_atlas_edition_map mm
                            WHERE mm.external_id = f.external_id LIMIT 1) m ON true
      RETURNING 1
    ), clr AS (
      UPDATE public.edition_offers o
         SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
        FROM f
       WHERE o.collection_id = v_cid AND o.external_id = f.external_id
         AND o.low_ask_nft_id = f.old_low_ask_nft_id AND o.low_ask IS NOT NULL
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM f), (SELECT count(*) FROM evup), (SELECT count(*) FROM clr)
      INTO v_found, v_floor_events, v_cleared;

    -- 3. RE-VERIFY cleared editions that are still NULL; ones the next sync already refilled need no probe.
    UPDATE public.topshot_sold_floor_clears c SET refilled_before_verify = true
      FROM public.edition_offers o
     WHERE c.verify_dispatched_at IS NULL AND NOT c.refilled_before_verify
       AND o.collection_id = v_cid AND o.external_id = c.external_id AND o.low_ask IS NOT NULL;
    GET DIAGNOSTICS v_refilled = ROW_COUNT;

    FOR r IN
      WITH inflight AS MATERIALIZED (
        SELECT q.error FROM public.topshot_atlas_market_requests q
         WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
      ), cand AS (
        SELECT DISTINCT ON (c.atlas_edition_id) c.id, c.atlas_edition_id, c.cleared_at
          FROM public.topshot_sold_floor_clears c
         WHERE c.verify_dispatched_at IS NULL AND NOT c.refilled_before_verify
           AND c.atlas_edition_id IS NOT NULL AND c.cleared_at > now() - interval '3 days'
         ORDER BY c.atlas_edition_id, c.cleared_at DESC
      )
      SELECT cand.id, cand.atlas_edition_id
        FROM cand LEFT JOIN inflight i ON i.error = '__edition__' || cand.atlas_edition_id
       WHERE i.error IS NULL
       ORDER BY cand.cleared_at DESC
       LIMIT GREATEST(p_verify, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nba', 'editionId', r.atlas_edition_id, 'limit', 200),
        headers := public.atlas_market_headers('nba'),
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
      VALUES (v_req, 'nba', -4, '__edition__' || r.atlas_edition_id);
      UPDATE public.topshot_sold_floor_clears
         SET verify_dispatched_at = now(), verify_request_id = v_req
       WHERE atlas_edition_id = r.atlas_edition_id AND verify_dispatched_at IS NULL AND NOT refilled_before_verify;
      v_dispatched := v_dispatched + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  -- bounded after the catch: one upsert, one log row.
  IF v_err IS NULL THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_sold_floor_asks_found', v_found, now(),
            (extract(epoch from clock_timestamp() - v_started) * 1000)::int)
    ON CONFLICT (metric) DO UPDATE SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END IF;
  PERFORM public.log_pipeline_run('ts-sold-floor-clear', v_started, v_found, v_cleared + v_recent + v_backlog + v_floor_events, 0,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('via', 'pg_cron',
      'listings_closed_recent', v_recent, 'listings_closed_backlog', v_backlog, 'backlog_scanned', v_backlog_scanned,
      'floors_found', v_found, 'floor_listing_events_closed', v_floor_events, 'floors_cleared', v_cleared, 'refilled_before_verify', v_refilled,
      'verify_dispatched', v_dispatched,
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('listings_closed_recent', v_recent, 'listings_closed_backlog', v_backlog,
    'backlog_scanned', v_backlog_scanned, 'floors_found', v_found, 'floor_listing_events_closed', v_floor_events,
    'floors_cleared', v_cleared, 'refilled_before_verify', v_refilled, 'verify_dispatched', v_dispatched, 'error', v_err);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.close_sold_topshot_listings_and_floors(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_sold_topshot_listings_and_floors(int, int) TO postgres, service_role;
