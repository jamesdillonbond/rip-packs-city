-- audit_20261126_topshot_offer_pull_restamp_ask_only_legendary — the one-off half of
-- audit_20261126_topshot_offer_pull_legendary_skip_covers_ask_only (20261126221042): record, then re-stamp the
-- CURRENT latest Top Shot ASK_ONLY `_bidpull` rows of Legendary / Ultimate editions the new rule would not have
-- pulled (offer under half the pre-pull price, a market sale inside 365 days). Dry run 2:15 PM PT: 329 editions.
-- The pre-pull price of these rows is not stored (the log began 1:24 PM PT): it is the inverse
-- (fmv / bid^0.75)^4 with the offer that stood at the row's computed_at (cents-level rounding; the next recalc
-- writes the exact value through the trigger).
-- REVERT: UPDATE public.fmv_snapshots fs SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--   FROM public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
--  WHERE fs.id = b.snapshot_id AND fs.fmv_usd = b.new_fmv_usd;
CREATE TABLE IF NOT EXISTS public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup (
  snapshot_id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  tier text,
  bid_usd numeric,
  old_fmv_usd numeric NOT NULL,
  new_fmv_usd numeric NOT NULL,
  old_algo_version text,
  new_algo_version text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup FROM PUBLIC, anon, authenticated;

WITH ed AS MATERIALIZED (
  SELECT e.id, e.tier::text AS tier
    FROM public.editions e
   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.tier IN ('LEGENDARY', 'ULTIMATE')
), latest AS MATERIALIZED (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.computed_at, fs.fmv_usd::numeric AS fmv,
         fs.confidence, fs.algo_version, ed.tier
    FROM public.fmv_snapshots fs
    JOIN ed ON ed.id = fs.edition_id
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.computed_at >= now() - interval '6 days'
   ORDER BY fs.edition_id, fs.computed_at DESC
), p AS (
  SELECT l.*, b.bid
    FROM latest l
   CROSS JOIN LATERAL (
     SELECT max(o.offer_amount_usd)::numeric AS bid
       FROM public.offers o
      WHERE o.edition_id = l.edition_id
        AND o.offer_type IN ('edition', 'subedition')
        AND o.created_at <= l.computed_at
        AND (o.resolved_at IS NULL OR o.resolved_at > l.computed_at)) b
   WHERE l.confidence = 'ASK_ONLY' AND l.algo_version LIKE '%\_bidpull' AND b.bid IS NOT NULL AND b.bid < l.fmv
), q AS (
  SELECT p.*, round(power(p.fmv / power(p.bid, 0.75), 4), 2) AS pre
    FROM p
), r AS (
  SELECT q.*
    FROM q
   WHERE q.bid < 0.5 * q.pre AND q.bid >= 0.10 * q.pre AND q.pre > q.fmv
     AND EXISTS (SELECT 1 FROM public.sales_market s
                  WHERE s.edition_id = q.edition_id AND s.sold_at > now() - interval '365 days')
)
INSERT INTO public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup
  (snapshot_id, edition_id, tier, bid_usd, old_fmv_usd, new_fmv_usd, old_algo_version, new_algo_version)
SELECT r.id, r.edition_id, r.tier, r.bid, r.fmv, r.pre, r.algo_version, regexp_replace(r.algo_version, '_bidpull$', '')
  FROM r
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = b.new_algo_version
  FROM public.audit_20261126_topshot_offer_pull_restamp_ask_only_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.computed_at >= now() - interval '7 days'
   AND fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND fs.confidence = 'ASK_ONLY'
   AND fs.fmv_usd = b.old_fmv_usd;