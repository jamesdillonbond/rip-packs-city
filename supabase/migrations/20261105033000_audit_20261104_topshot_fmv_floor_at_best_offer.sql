-- audit_20261104_topshot_fmv_floor_at_best_offer — 2026-11-04 ~7:40 PM PT (Claude Code cloud; Trevor: "We need to get
-- confidence on pricing. That's the anchor of everything we do." → "Keep going and do it all").
--
-- A Top Shot FMV is never below the best OPEN edition-level offer on that edition: a Moment is worth at least what a
-- buyer has a live, standing offer to pay for any copy of it today. New BEFORE INSERT guard on fmv_snapshots, named so
-- it fires AFTER every cap (Postgres orders BEFORE row triggers by name: …_cap_* < …_floor_* < …_touch_*/…_zero_*/tg_*),
-- so the order is "capped at the sales evidence, then floored at the live bid". Marked algo_version …_bidfloor. Bounded:
-- an offer more than 3x the price is ignored (an unfunded or troll offer must not drag a price up; 2 of 740 moved
-- backtest sales sat there).
--
-- Backtest (all clean Top Shot sales since 2026-10-23 PT, serial > 25, `sales_market`; the snapshot in force >= 1 day
-- before the sale; the best edition offer OPEN at that same instant, reconstructed from offers.created_at /
-- resolved_at / expires_at — i.e. information available a day before the sale):
--   rows the floor moves (offer above the published price), by offer / price:
--     <= 1.5x  n 633: within +/-25 % 59.6 -> 73.1, median ratio 1.00
--     1.5-3x   n 105: within +/-25 %  0.0 -> 61.9, median ratio 0.79
--     > 3x     n   2: excluded by the 3x bound
--   by confidence (10-23..10-27 slice): HIGH moved 42: 57.1 -> 81.0 (all HIGH 76.4 -> 77.0);
--     MEDIUM moved 141: 56.0 -> 74.5 (all MEDIUM 60.7 -> 61.2)
--   ASK_ONLY / LOW with an offer, split by how the sale happened (the circularity check — an offer that is later
--   ACCEPTED predicts its own fill): listing purchases ASK_ONLY 65.4 -> 69.2, LOW 44.2 -> 49.2; offer fills ASK_ONLY
--   64.8 -> 65.9, LOW 56.9 -> 62.0. Better in every cell. (The offer ALONE is not a price: on listing purchases it sits
--   at ~0.6-0.67 of the sale. It is a floor, not an estimate.)
-- Sized 2026-11-04 ~7:35 PM PT on edition_fmv_current: 407 Top Shot editions sit below a live offer (LOW 315, MEDIUM 79,
-- HIGH 10, ASK_ONLY 3), $8,130 -> $9,435 summed. Pairs with 20261105024000 (ask-only capped at the last sale): once that
-- cap lands, a capped price that falls under a live offer is lifted back to it.
--
-- Cost: one index-only-ish probe per Top Shot insert on idx_offers_open_edition_rollup
-- (collection_id, edition_id) INCLUDE (offer_amount_usd, offer_type, created_at) WHERE status = 'open' — heap fetch
-- for expires_at only.
--
-- anon-exec: intentional — trigger function (RETURNS trigger), never callable through PostgREST; EXECUTE revoked from PUBLIC/anon/authenticated below (fmv_snapshots_floor_topshot_at_best_offer)
--
-- REVERT:
--   DROP TRIGGER fmv_snapshots_floor_topshot_at_best_offer_trg ON public.fmv_snapshots;
--   UPDATE public.fmv_snapshots f SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--     FROM public.audit_20261104_topshot_fmv_bidfloor_backup b WHERE f.id = b.snapshot_id;
--   UPDATE public.edition_fmv_current c SET fmv_usd = b.old_fmv_usd
--     FROM public.audit_20261104_topshot_fmv_bidfloor_backup b
--    WHERE c.edition_id = b.edition_id AND c.fmv_usd = b.new_fmv_usd;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_floor_topshot_at_best_offer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_topshot constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_bid numeric;
BEGIN
  IF NEW.collection_id = c_topshot
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.fmv_usd > 0
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT max(o.offer_amount_usd)
      INTO v_bid
      FROM public.offers o
     WHERE o.collection_id = c_topshot
       AND o.edition_id = NEW.edition_id
       AND o.status = 'open'
       AND o.offer_type = 'edition'
       AND (o.expires_at IS NULL OR o.expires_at > now());
    IF v_bid IS NOT NULL AND v_bid > NEW.fmv_usd AND v_bid <= 3 * NEW.fmv_usd THEN
      NEW.fmv_usd := round(v_bid, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_bidfloor';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fmv_snapshots_floor_topshot_at_best_offer() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fmv_snapshots_floor_topshot_at_best_offer() IS
  'BEFORE INSERT guard on fmv_snapshots (2026-11-04): a Top Shot fmv_usd is raised to the best OPEN, unexpired edition-level offer when that offer is above it and at most 3x it, marked algo_version …_bidfloor. Fires after every _cap_ trigger (name order). Backtested on clean post-10-23 sales: moved rows 59.6 -> 73.1 % within +/-25 (<=1.5x), better in every confidence tier and for both listing purchases and offer fills.';

DROP TRIGGER IF EXISTS fmv_snapshots_floor_topshot_at_best_offer_trg ON public.fmv_snapshots;
CREATE TRIGGER fmv_snapshots_floor_topshot_at_best_offer_trg
  BEFORE INSERT ON public.fmv_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fmv_snapshots_floor_topshot_at_best_offer();

CREATE TABLE IF NOT EXISTS public.audit_20261104_topshot_fmv_bidfloor_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  floored_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261104_topshot_fmv_bidfloor_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261104_topshot_fmv_bidfloor_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.fmv_usd, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   ORDER BY fs.edition_id, fs.computed_at DESC
), b AS (
  SELECT l.id, l.edition_id, l.fmv_usd, l.algo_version,
         (SELECT max(o.offer_amount_usd) FROM public.offers o
           WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND o.edition_id = l.edition_id AND o.status = 'open' AND o.offer_type = 'edition'
             AND (o.expires_at IS NULL OR o.expires_at > now())) AS bid
    FROM latest l
   WHERE l.fmv_usd IS NOT NULL AND l.fmv_usd > 0
)
INSERT INTO public.audit_20261104_topshot_fmv_bidfloor_backup (snapshot_id, edition_id, old_fmv_usd, new_fmv_usd, old_algo_version)
SELECT b.id, b.edition_id, b.fmv_usd, round(b.bid, 2), b.algo_version
  FROM b
 WHERE b.bid IS NOT NULL AND b.bid > b.fmv_usd AND b.bid <= 3 * b.fmv_usd
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = COALESCE(fs.algo_version, '') || '_bidfloor'
  FROM public.audit_20261104_topshot_fmv_bidfloor_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.fmv_usd = b.old_fmv_usd;

UPDATE public.edition_fmv_current c
   SET fmv_usd = b.new_fmv_usd, refreshed_at = now()
  FROM public.audit_20261104_topshot_fmv_bidfloor_backup b
 WHERE c.edition_id = b.edition_id
   AND c.fmv_usd = b.old_fmv_usd;

DO $mig$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.audit_20261104_topshot_fmv_bidfloor_backup;
  IF n < 150 OR n > 1500 THEN
    RAISE EXCEPTION 'topshot bid floor lifted % rows; expected ~407 measured 11-04 7:35 PM PT (more if the last-sale cap applied first)', n;
  END IF;
END
$mig$;
