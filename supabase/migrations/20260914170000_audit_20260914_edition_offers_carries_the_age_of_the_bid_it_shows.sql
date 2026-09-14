-- audit_20260914: edition_offers carries the AGE of the bid it shows
--
-- WHY. /insights/offer-spread prints a best-offer price with no hint of how long
-- it has stood. Measured 2026-09-14: of 7,775 TS editions with a bid, the median
-- standing bid is 12.8 days old and the p90 is 58.0 days. A two-month-old bid and
-- a bid from this morning read identically on the board today.
--
-- The data already existed and was never surfaced: /api/topshot-offers-indexer
-- writes `offers.created_at = o.blockTs` — the OfferAvailable BLOCK timestamp,
-- not the row-insert time (confirmed in source, and by distribution: 25,243 open
-- rows spread across 15,206 distinct minutes, which insert-time cannot produce).
--
-- ⛔ WHY A COLUMN AND NOT A JOIN IN THE VIEW. Measured all three against the
-- baseline rather than reasoned about:
--     view today                      80 ms /  4,357 buffers
--     + LATERAL per row           11,423 ms / 48,146 buffers
--     + pre-aggregated hash join   2,442 ms / 26,640 buffers
-- A 30x slowdown and 6x the IO on a PUBLIC board, against an IO-bound instance,
-- is not a trade worth making for one column. The work moves off the read path:
-- this column is written by the offers indexer and the view just selects it.
-- Re-measured after the change, as anon: 59 ms / 4,358 buffers — baseline intact.
--
-- ⚠ WHAT NULL DOES NOT MEAN. NULL is "we cannot age this bid", NEVER "this bid is
-- new". Two causes, indistinguishable from the value alone, so every surface must
-- render it as unknown rather than fresh:
--   (a) the on-chain offers indexer is FORWARD-ONLY from a ~8 h backfill, so an
--       offer created before 2026-06-03 has no row at all; and
--   (b) the chain's best open offer may not equal edition_offers.highest_offer
--       (different writers, different moments), and pinning one's age onto the
--       other's price would fabricate the pairing.
-- Coverage at first write: 3,914 of 7,775 editions with a bid (50.3%).
--
-- REVERT (in this order):
--   -- re-run the NEXT migration with the `eo.best_offer_at` line removed first,
--   -- then:
--   DROP FUNCTION public.sync_edition_offers_best_offer_at();
--   ALTER TABLE public.edition_offers DROP COLUMN best_offer_at;

ALTER TABLE public.edition_offers
  ADD COLUMN IF NOT EXISTS best_offer_at timestamptz;

COMMENT ON COLUMN public.edition_offers.best_offer_at IS
  'Block timestamp of the OfferAvailable event for the open on-chain offer whose amount EQUALS this row''s highest_offer — i.e. the age of the bid this row displays. Written by sync_edition_offers_best_offer_at() from offers.created_at (which the topshot-offers-indexer sets to the block ts, not the insert ts). NULL means UNAGEABLE, never new: the on-chain indexer is forward-only from a ~8h backfill (2026-06-03 onward), and the chain best may not equal highest_offer, in which case pairing them would fabricate a claim. Surfaces must render NULL as "unknown", never as fresh. audit_20260914.';

-- One pass, off the read path. Writes only where the value actually changes, so
-- a no-op tick costs nothing downstream (verified: the second call wrote 0 rows).
CREATE OR REPLACE FUNCTION public.sync_edition_offers_best_offer_at()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH chain_best AS (
    SELECT o.collection_id,
           o.edition_id,
           o.offer_amount_usd,
           max(o.created_at) AS best_offer_at
      FROM offers o
     WHERE o.status = 'open'
       AND o.offer_type NOT IN ('subedition','serial')
       AND o.created_at IS NOT NULL
     GROUP BY o.collection_id, o.edition_id, o.offer_amount_usd
  ), matched AS (
    SELECT eo.collection_id, eo.external_id, cb.best_offer_at
      FROM edition_offers eo
      JOIN editions e
        ON e.external_id::text = eo.external_id
       AND e.collection_id = eo.collection_id
      -- The amount equality is the honesty gate: an age is only attached when it
      -- belongs to the very offer whose price this row shows.
      LEFT JOIN chain_best cb
        ON cb.collection_id = eo.collection_id
       AND cb.edition_id = e.id
       AND cb.offer_amount_usd = eo.highest_offer
     WHERE eo.highest_offer > 0
  ), updated AS (
    UPDATE edition_offers eo
       SET best_offer_at = m.best_offer_at
      FROM matched m
     WHERE eo.collection_id = m.collection_id
       AND eo.external_id  = m.external_id
       AND eo.best_offer_at IS DISTINCT FROM m.best_offer_at
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM updated;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_edition_offers_best_offer_at()
  FROM PUBLIC, anon, authenticated;
