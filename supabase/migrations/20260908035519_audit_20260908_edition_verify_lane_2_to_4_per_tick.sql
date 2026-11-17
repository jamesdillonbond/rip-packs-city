-- anon-exec: intentional — CREATE OR REPLACE with the SAME signature (p_max integer) preserves the existing ACL (anon EXECUTE false, service_role true, verified post-apply) (atlas_listing_verify_tick)
-- audit_20260908: the Atlas EDITION verify lane reads 4 editions per tick instead of 2 (#67 (2), decided).
--
-- WHY. The 08-28 → 09-06 Top Shot sales hole (the GraphQL host died; ~70 % of listing sales lost for
-- ten days) is inside every edition's 30-day MEDIUM/HIGH window until ~10-06. The only thing filling it
-- is this lane: each `{product:'nba', editionId}` read returns the edition's FULL history newest-first
-- (200/page), the sync upserts the purchased listings, and `sync_sales_from_atlas` writes the ones the
-- ledger lacks. Measured 2026-09-08 03:5xZ: 1,331 editions verified in the last 24 h at 2/tick
-- (~92 % of the 1,440 theoretical), so the 14,015 canonical editions take ~10.5 days. At 4/tick the
-- same walk takes ~5 days — inside the window's remaining life, where 10.5 days barely is.
-- Cost: +1 Atlas request/min (lane 1 → 2/min; estate ~5 → ~6/min), each a ~200-row page. The lane's
-- 403 share is the falsifier: the `atlas-market-upstream-403` arm (info at the ~7–12 % Cloudflare
-- base) — if the edition lane's share climbs above the listing lane's, revert to 2. The options the
-- register named — a separate 14K-edition history walk at the full budget for ~2 days — was rejected
-- as a burst against a WAF-challenged host; this is the same walk at a measured, reversible pace.
--
-- Body VERBATIM from 20260907055104 except the literal `atlas_edition_verify_dispatch(2)` → `(4)`.
-- REVERT: re-apply with `(2)`.

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
