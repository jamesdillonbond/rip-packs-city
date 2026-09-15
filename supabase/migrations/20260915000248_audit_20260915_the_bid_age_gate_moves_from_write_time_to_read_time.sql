-- audit_20260915: the bid-age honesty gate moves from WRITE time to READ time
--
-- 🚨 THE DEFECT, in my own 2026-09-14 change. `best_offer_at` is only honest
-- while it is paired with the price it was computed for. The amount-equality
-- gate ran inside sync_edition_offers_best_offer_at() — i.e. at WRITE time —
-- but TWO OTHER FUNCTIONS write edition_offers.highest_offer and neither
-- touches best_offer_at:
--     raise_edition_offers_from_chain()
--     sync_edition_offers_from_atlas()
-- They run on their own schedules. Between syncs the price moves and the age
-- does not, so the board renders an age belonging to a DIFFERENT offer than the
-- number beside it — the fabricated pairing the feature exists to prevent.
--
-- ⚠ MEASURED, NOT ASSUMED — AND MY FIRST READING WAS A FALSE NEGATIVE. A direct
-- count of mispaired rows returned 0, because I happened to query just after a
-- sync: a null result with no positive control. Re-measured against the window
-- instead: 9m42s after the last sync, 7 rows had been price-touched by another
-- writer and 1 of them carried an age. The exposure is continuous, roughly one
-- wrong pairing per ten minutes of drift, not a rare race.
--
-- THE FIX. Record the amount the age was computed for, and gate in the VIEW.
-- A stale pairing then cannot be rendered at all: it degrades to NULL, which the
-- surface already renders as "unknown" with hover copy (lib/market/bid-age.ts).
-- The failure mode becomes "we do not know" instead of "here is a wrong number",
-- which is the whole argument of the original change.
--
-- The view's column list, names, order and types are unchanged — only the
-- expression behind best_offer_at — so no consumer needs to change.
--
-- ⚠ CREATE OR REPLACE VIEW resets reloptions; security_invoker=on is re-applied
-- below in the same migration (live definition re-read immediately before this).
--
-- REVERT:
--   re-run with `eo.best_offer_at` in place of the CASE, then
--   ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);
--   ALTER TABLE public.edition_offers DROP COLUMN best_offer_at_amount;
--   (and restore the previous sync function body).

ALTER TABLE public.edition_offers
  ADD COLUMN IF NOT EXISTS best_offer_at_amount numeric;

COMMENT ON COLUMN public.edition_offers.best_offer_at_amount IS
  'The highest_offer value that best_offer_at was computed against. The view emits best_offer_at ONLY while this still equals highest_offer, so an age can never be shown beside a price it does not belong to. Needed because raise_edition_offers_from_chain() and sync_edition_offers_from_atlas() both move highest_offer without touching best_offer_at. audit_20260915.';

-- Write both, always together.
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
    SELECT eo.collection_id,
           eo.external_id,
           cb.best_offer_at,
           -- NULL when unmatched, so the pair is written or cleared as one unit.
           CASE WHEN cb.best_offer_at IS NOT NULL THEN eo.highest_offer END AS amt
      FROM edition_offers eo
      JOIN editions e
        ON e.external_id::text = eo.external_id
       AND e.collection_id = eo.collection_id
      LEFT JOIN chain_best cb
        ON cb.collection_id = eo.collection_id
       AND cb.edition_id = e.id
       AND cb.offer_amount_usd = eo.highest_offer
     WHERE eo.highest_offer > 0
  ), updated AS (
    UPDATE edition_offers eo
       SET best_offer_at        = m.best_offer_at,
           best_offer_at_amount = m.amt
      FROM matched m
     WHERE eo.collection_id = m.collection_id
       AND eo.external_id  = m.external_id
       AND (eo.best_offer_at        IS DISTINCT FROM m.best_offer_at
         OR eo.best_offer_at_amount IS DISTINCT FROM m.amt)
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM updated;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_edition_offers_best_offer_at()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE VIEW public.topshot_offer_ask_spread AS
 SELECT e.external_id,
    e.name,
    e.player_name,
    e.set_name,
    e.tier,
    e.circulation_count,
    eo.highest_offer,
    eo.low_ask,
    round(eo.highest_offer / eo.low_ask * 100::numeric, 1) AS offer_pct_of_ask,
    round(abs(eo.highest_offer / eo.low_ask * 100::numeric - 100::numeric), 1) AS par_distance,
    round(eo.low_ask - eo.highest_offer, 2) AS spread_usd,
    eo.highest_offer >= eo.low_ask AS bid_meets_ask,
    eo.updated_at,
    -- READ-TIME GATE: the age is emitted only while it still belongs to the
    -- price beside it. Anything else is NULL = "unknown", never a wrong number.
    CASE
      WHEN eo.best_offer_at_amount IS NOT NULL
       AND eo.best_offer_at_amount = eo.highest_offer
      THEN eo.best_offer_at
    END AS best_offer_at
   FROM edition_offers eo
     JOIN editions e ON e.external_id::text = eo.external_id AND e.collection_id = eo.collection_id
  WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND eo.highest_offer > 0::numeric AND eo.low_ask > 0::numeric
  ORDER BY (round(abs(eo.highest_offer / eo.low_ask * 100::numeric - 100::numeric), 1));

ALTER VIEW public.topshot_offer_ask_spread SET (security_invoker = on);

GRANT SELECT ON public.topshot_offer_ask_spread TO anon, authenticated;