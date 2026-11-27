-- audit_20261127_topshot_bids_closed_on_chain_retired — 2026-11-27 ~11:00 AM PT (Claude Code, Windows box;
-- Trevor: "work through any recent handoffs that have tasks you can tackle"). Follow-up filed in the ledger by
-- 20261127162858 (offer_spread_shows_only_bids_seen_in_24h): "moment pages / checklists / get_edition_high_offer
-- still read the unstamped highest_offer".
--
-- THE DEFECT: edition_offers.highest_offer for Top Shot is written by sync_edition_offers_from_atlas() step (b)
-- (only for editions Atlas VERIFIED in the last 24 h) and raise_edition_offers_from_chain() (RAISE-ONLY). Nothing
-- lowers a bid on an edition Atlas has not re-walked, so a cancelled or filled bid stands for weeks on every reader
-- of the column: edition + moment pages (get_edition_high_offer), checklists, /api/best-offers, badges price_gap,
-- the concierge. Ace Bailey 219:7423::17 showed $91 (cancelled on chain 11-10) vs $68 live.
--
-- MEASURED before this file (11-27 ~10:58 AM PT): 8,982 Top Shot rows carry a bid; 3,853 were seen open in 24 h.
-- Of the rest, 2,214 have POSITIVE evidence the bid is gone — and only those are touched:
--   • an on-chain offer on that edition at EXACTLY that amount is cancelled/filled (offers.status), and
--   • no on-chain offer at that amount is still open, and
--   • the stored bid was not seen open in the last 24 h (highest_offer_seen_* stamp, job 942), and
--   • no open Atlas EDITION/PARALLEL offer event at that price was seen AFTER the chain close
--     (a later sighting is a different, live offer at the same price).
-- 717 filled, 1,497 cancelled; median 10.8 days since the close; $141,440 of bids. Absence of evidence (2,998 rows
-- with no chain record at all) is NOT acted on: Atlas re-reports only changed listings, so "not seen" ≠ "gone".
--
-- THE FIX: retire_closed_topshot_bids() sets those rows' highest_offer NULL (logged row-by-row, old value kept),
-- then calls raise_edition_offers_from_chain() in the same call, which re-raises each one to its max OPEN,
-- marketplace-acceptable chain edition offer (#220 hidden-offer rule) — so a page shows the live bid, or none.
-- 145 of the 2,214 have no open chain offer of any kind and go to "—". Parallel (::) pages also read their own
-- open subedition offers at read time (get_edition_high_offer chain_sub), unchanged.
-- Nothing re-raises a retired bid: the GQL offers-sweep has not run (no pipeline_runs in 3 days, public-api dead);
-- Atlas step (b) writes only what it saw open in 24 h. pg_cron 'rpc-topshot-closed-bid-retire' at :43 hourly.
-- Cost measured as a SELECT: 2,214 rows, ~202k buffers, 10.8 s COLD (IO reads on the Atlas cover index); the
-- steady-state population after the first run is the hourly new closures.
--
-- ⚠ EDITED IN PLACE 11-27 ~11:30 AM PT: as applied (version 20261127190307) both handlers read `WHEN OTHERS`,
-- blind to a statement_timeout kill (R118 guard reddened CI). Live body fixed by 20261127193157; this file now
-- carries the corrected handlers so the forward-only guard reads the intended body.
--
-- anon-exec: revoked (retire_closed_topshot_bids) — new function; revoked from PUBLIC, anon, authenticated below,
-- EXECUTE granted to service_role (the pg_cron caller is the owner, postgres).
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-closed-bid-retire');
--   UPDATE public.edition_offers eo SET highest_offer = l.old_highest_offer, updated_at = now()
--     FROM (SELECT DISTINCT ON (external_id) external_id, old_highest_offer FROM public.topshot_closed_bid_retirements
--            ORDER BY external_id, retired_at) l
--    WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = l.external_id;
--   DROP FUNCTION public.retire_closed_topshot_bids();
--   (keep the log table, or DROP TABLE public.topshot_closed_bid_retirements;)

CREATE TABLE IF NOT EXISTS public.topshot_closed_bid_retirements (
  id bigserial PRIMARY KEY,
  external_id text NOT NULL,
  old_highest_offer numeric NOT NULL,
  closed_status text NOT NULL,
  closed_at timestamptz,
  retired_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.topshot_closed_bid_retirements IS
  'Top Shot edition_offers.highest_offer values retired because the matching on-chain offer was cancelled/filled and nothing showed it open since. Written by retire_closed_topshot_bids(). audit_20261127.';
ALTER TABLE public.topshot_closed_bid_retirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_closed_bid_retirements FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_topshot_closed_bid_retirements_ext ON public.topshot_closed_bid_retirements (external_id, retired_at);

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

REVOKE ALL ON FUNCTION public.retire_closed_topshot_bids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retire_closed_topshot_bids() TO service_role;

SELECT cron.schedule('rpc-topshot-closed-bid-retire', '43 * * * *', $cmd$SELECT public.retire_closed_topshot_bids();$cmd$);
