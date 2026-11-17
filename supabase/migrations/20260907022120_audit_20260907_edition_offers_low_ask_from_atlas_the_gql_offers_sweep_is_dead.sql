-- audit_20260907: edition_offers.low_ask for Top Shot comes from Atlas — the GQL offers-sweep is dead.
--
-- WHY. `offers-sweep` (cron-job.org, ~20 min) walks Top Shot's marketplace GraphQL to cache each
-- edition's lowest ask + top offer into `edition_offers` — the "best offer / lowest ask" on the
-- collection grid, moment and edition pages, and fmv-recalc's ask feed. That host answers 530
-- since the ~08-28 decommission; the sweep now logs `ok=true, skipped: upstream_outage` every
-- tick (the "sweep ok means COMPLETED, not that its lanes worked" class) and 12,259 Top Shot rows
-- carry a `low_ask` nobody has refreshed. Measured 2026-09-07 02:20Z against the live Atlas floor
-- (open listings verified in the last 24 h): of 464 editions with both, **431 differ, 395 show a
-- HIGHER stale ask than the live floor** — under-reported deals, and a false "lowest ask" on every
-- one of those pages.
--
-- `sync_edition_offers_from_atlas()` upserts low_ask / low_ask_serial / low_ask_nft_id / updated_at
-- per CANONICAL external_id (parallels → their `::sub` row, per the per-printing rule) from the
-- verified open listing set. It touches ONLY editions Atlas has an open listing for — Atlas is not
-- a complete census (the 09-04 lesson), so an edition with no open listing in our events is left
-- alone rather than NULLed. `highest_offer` is NOT written here: offer withdrawals are not in the
-- firehose and nothing re-verifies an offer yet — a withdrawn "best offer" is a claim a reader may
-- list against, so that column keeps its existing (on-chain-raised) path until a verify read exists.
-- Folded into atlas_listing_verify_tick(); the pipeline row's extra carries `edition_offers`.
--
-- REVERT: DROP FUNCTION public.sync_edition_offers_from_atlas(); re-apply atlas_listing_verify_tick
--   from 20260907021459. (Rows already refreshed keep their live values — there is no stale
--   value worth restoring.)

CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int;
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
  RETURN jsonb_build_object('rows', v_n, 'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_edition_offers_from_atlas() TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_sync jsonb; v_cl jsonb; v_eo jsonb; v_disp jsonb; v_err text;
BEGIN
  BEGIN
    v_sync := public.sync_ts_listings_from_atlas();
    v_cl := public.sync_cached_listings_from_atlas();
    v_eo := public.sync_edition_offers_from_atlas();
    v_disp := public.atlas_listing_verify_dispatch(p_max);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-listings-atlas-sync', v_started, 1, COALESCE((v_sync->>'rows')::int, 0),
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo, 'verify', v_disp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo, 'verify', v_disp, 'error', v_err);
END $$;
-- anon-exec: intentional — same signature as 20260907020428, ACLs preserved (atlas_listing_verify_tick)
