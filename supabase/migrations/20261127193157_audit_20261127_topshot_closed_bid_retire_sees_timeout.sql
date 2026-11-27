-- audit_20261127_topshot_closed_bid_retire_sees_timeout — 2026-11-27 ~11:30 AM PT (Claude Code, Windows box).
--
-- 20261127190307 shipped retire_closed_topshot_bids() with two `EXCEPTION WHEN OTHERS` handlers. A
-- statement_timeout kill (57014 query_canceled) escapes WHEN OTHERS, so a killed run would have recorded nothing
-- (R118); __tests__/new-plpgsql-recording-handlers-catch-query-canceled.test.ts reddened CI on it. Both handlers now
-- name query_canceled. Handler tails are bounded: variable assignments, then one log_pipeline_run insert (the raise
-- call is skipped when the retire block failed). Body otherwise identical (re-read live prosrc md5 4ddf9094… first).
--
-- anon-exec: revoked (retire_closed_topshot_bids) — unchanged; CREATE OR REPLACE keeps the 20261127190307 grants.
--
-- REVERT: re-apply the function body from 20261127190307 with `WHEN OTHERS` (not recommended).

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
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
                          AND ev.kind = 'offer' AND NOT ev.completed
                          AND ev.offer_type IN ('EDITION', 'PARALLEL')
                          AND ev.price_cents = (eo.highest_offer * 100)::bigint
                          AND ev.last_seen_at > COALESCE(c.closed_at, '-infinity'::timestamptz));
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
