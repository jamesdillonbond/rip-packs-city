-- audit_20261127_topshot_closed_bid_retire_matches_atlas_by_offer_id — 2026-11-27 ~11:50 AM PT (Claude Code, Windows box).
--
-- DEFECT in 20261127190307: its Atlas guard matched closures by AMOUNT. It skipped a bid only when Atlas saw an
-- open offer at that price AFTER the newest chain closure at that price. Two bids can share a price: 163:5750 had a
-- $5 offer cancelled 11-02 and a second open $5 offer (152832117717307) Atlas saw 10-29 that our chain table has
-- never recorded — not proven gone, yet retired. Measured: 45 of the 2,214 retirements had an open Atlas
-- EDITION/PARALLEL offer at that price whose offer id is not closed on chain.
--
-- FIX: (1) the Atlas guard matches by offer id (listing_resource_id = offers.offer_id): any open Atlas offer at that
-- price not proven closed on chain keeps the bid. (2) Those 45 are restored to GREATEST(current, old) and stamped
-- restored_at in the log. Body otherwise identical to 20261127193157 (live prosrc md5 2c1f981c… re-read first).
--
-- anon-exec: revoked (retire_closed_topshot_bids) — unchanged; CREATE OR REPLACE keeps the grants.
--
-- REVERT: re-apply the 20261127193157 body; the 45 restored rows are listed by restored_at IS NOT NULL in
-- topshot_closed_bid_retirements (re-retire them only by re-running the old body).

ALTER TABLE public.topshot_closed_bid_retirements ADD COLUMN IF NOT EXISTS restored_at timestamptz;

WITH bad AS (
  SELECT DISTINCT ON (r.external_id) r.id, r.external_id, r.old_highest_offer
    FROM public.topshot_closed_bid_retirements r
   WHERE r.restored_at IS NULL
     AND EXISTS (SELECT 1 FROM public.topshot_atlas_edition_map m
                   JOIN public.topshot_atlas_market_events ev
                     ON ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                  WHERE m.external_id = r.external_id AND ev.kind = 'offer' AND NOT ev.completed
                    AND ev.offer_type IN ('EDITION', 'PARALLEL')
                    AND ev.price_cents = (r.old_highest_offer * 100)::bigint
                    AND NOT EXISTS (SELECT 1 FROM public.offers oc
                                     WHERE oc.offer_id = ev.listing_resource_id
                                       AND oc.status IN ('cancelled', 'filled')))
   ORDER BY r.external_id, r.retired_at
), fix AS (
  UPDATE public.edition_offers eo
     SET highest_offer = GREATEST(COALESCE(eo.highest_offer, 0), b.old_highest_offer), updated_at = now()
    FROM bad b
   WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = b.external_id
  RETURNING eo.external_id
)
UPDATE public.topshot_closed_bid_retirements r SET restored_at = now()
  FROM bad b WHERE r.external_id = b.external_id AND r.restored_at IS NULL;

CREATE OR REPLACE FUNCTION public.retire_closed_topshot_bids()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_cid constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_found int := 0; v_retired int := 0; v_raised int := NULL; v_err text; v_raise_err text;
BEGIN
  BEGIN
    CREATE TEMP TABLE IF NOT EXISTS _closed_bids (external_id text PRIMARY KEY, highest_offer numeric,
      closed_status text, closed_at timestamptz) ON COMMIT DROP;
    TRUNCATE _closed_bids;
    INSERT INTO _closed_bids
    SELECT eo.external_id, eo.highest_offer, c.status, c.closed_at
      FROM public.edition_offers eo
      JOIN public.editions e ON e.collection_id = eo.collection_id AND e.external_id::text = eo.external_id
      LEFT JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
     CROSS JOIN LATERAL (
       SELECT o.status, o.resolved_at AS closed_at
         FROM public.offers o
        WHERE o.edition_id = e.id AND o.collection_id = e.collection_id
          AND o.offer_amount_usd = eo.highest_offer AND o.status IN ('cancelled', 'filled')
        ORDER BY o.resolved_at DESC NULLS LAST
        LIMIT 1) c
     WHERE eo.collection_id = v_cid AND eo.highest_offer > 0
       AND NOT (eo.highest_offer_seen_amount IS NOT DISTINCT FROM eo.highest_offer
                AND eo.highest_offer_seen_at > now() - interval '24 hours')
       AND NOT EXISTS (SELECT 1 FROM public.offers o2
                        WHERE o2.edition_id = e.id AND o2.collection_id = e.collection_id
                          AND o2.offer_amount_usd = eo.highest_offer AND o2.status = 'open')
       -- An offer Atlas reports open at that price is evidence of a live bid unless THAT offer id is closed on
       -- chain (matched by id, never by amount: two bids can share a price). NULL id = unknown = keep.
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                          AND ev.kind = 'offer' AND NOT ev.completed
                          AND ev.offer_type IN ('EDITION', 'PARALLEL')
                          AND ev.price_cents = (eo.highest_offer * 100)::bigint
                          AND NOT EXISTS (SELECT 1 FROM public.offers oc
                                           WHERE oc.offer_id = ev.listing_resource_id
                                             AND oc.status IN ('cancelled', 'filled')));
    GET DIAGNOSTICS v_found = ROW_COUNT;

    -- Log first, then clear only what was logged (same transaction; a failure rolls back both).
    INSERT INTO public.topshot_closed_bid_retirements (external_id, old_highest_offer, closed_status, closed_at)
    SELECT external_id, highest_offer, closed_status, closed_at FROM _closed_bids;

    UPDATE public.edition_offers eo
       SET highest_offer = NULL, updated_at = now()
      FROM _closed_bids b
     WHERE eo.collection_id = v_cid AND eo.external_id = b.external_id
       AND eo.highest_offer = b.highest_offer;
    GET DIAGNOSTICS v_retired = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_retired := 0;
  END;

  -- Re-raise to the live chain bid. Its own failure is reported, not hidden; the retire above stands either way
  -- (an absent bid is honest; the hourly :34 backstop job 216 retries the raise).
  IF v_err IS NULL AND v_retired > 0 THEN
    BEGIN
      v_raised := public.raise_edition_offers_from_chain();
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_raise_err := left(SQLERRM, 300);
    END;
  END IF;

  PERFORM public.log_pipeline_run('topshot-closed-bid-retire', v_started, v_found, v_retired, 0,
    v_err IS NULL AND v_raise_err IS NULL, COALESCE(v_err, v_raise_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('via', 'pg_cron', 'found', v_found, 'retired', v_retired,
      'raised', v_raised, 'raise_error', v_raise_err,
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('found', v_found, 'retired', v_retired, 'raised', v_raised,
    'error', v_err, 'raise_error', v_raise_err);
END
$fn$;
