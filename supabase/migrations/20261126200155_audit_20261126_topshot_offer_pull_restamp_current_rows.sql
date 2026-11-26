-- audit_20261126_topshot_offer_pull_restamp_current_rows — the one-off half of
-- audit_20261126_topshot_offer_pull_low_offer_floor_and_legendary_skip: record, then re-stamp the CURRENT latest
-- Top Shot LOW `_bidpull` rows the new rule would have priced higher (dry run 12:10 PM PT: 259 of 1,869 —
-- 78 Legendary / Ultimate back to the pre-pull price, 181 lifted to half of it).
-- The pre-pull price is not stored: it is asp_usd where that reproduces the pulled price, else the inverse
-- (fmv / bid^0.75)^4 with the offer that stood at the row's computed_at (cents-level rounding; the next
-- daily recalc writes the exact value through the trigger).
-- REVERT: UPDATE public.fmv_snapshots fs SET fmv_usd = b.old_fmv_usd, algo_version = b.old_algo_version
--   FROM public.audit_20261126_topshot_offer_pull_restamp_backup b
--  WHERE fs.id = b.snapshot_id AND fs.fmv_usd = b.new_fmv_usd;
CREATE TABLE IF NOT EXISTS public.audit_20261126_topshot_offer_pull_restamp_backup (
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
ALTER TABLE public.audit_20261126_topshot_offer_pull_restamp_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261126_topshot_offer_pull_restamp_backup FROM PUBLIC, anon, authenticated;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.id, fs.edition_id, fs.computed_at, fs.fmv_usd::numeric AS fmv,
         fs.asp_usd::numeric AS asp, fs.confidence, fs.algo_version
    FROM public.fmv_snapshots fs
   WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND fs.computed_at >= now() - interval '6 days'
   ORDER BY fs.edition_id, fs.computed_at DESC
), p AS (
  SELECT l.*, b.bid, e.tier::text AS tier
    FROM latest l
    JOIN public.editions e ON e.id = l.edition_id
   CROSS JOIN LATERAL (
     SELECT max(o.offer_amount_usd)::numeric AS bid
       FROM public.offers o
      WHERE o.edition_id = l.edition_id
        AND o.offer_type IN ('edition', 'subedition')
        AND o.created_at <= l.computed_at
        AND (o.resolved_at IS NULL OR o.resolved_at > l.computed_at)) b
   WHERE l.confidence = 'LOW' AND l.algo_version LIKE '%\_bidpull' AND b.bid IS NOT NULL AND b.bid < l.fmv
), q AS (
  SELECT p.*,
         CASE WHEN p.asp IS NOT NULL AND abs(round(power(p.asp, 0.25) * power(p.bid, 0.75), 2) - p.fmv) <= 0.01
              THEN p.asp ELSE round(power(p.fmv / power(p.bid, 0.75), 4), 2) END AS pre
    FROM p
), r AS (
  SELECT q.*,
         CASE WHEN q.tier IN ('LEGENDARY', 'ULTIMATE') AND q.bid < 0.5 * q.pre THEN round(q.pre, 2)
              ELSE greatest(q.fmv, round(0.5 * q.pre, 2)) END AS new_fmv,
         (q.tier IN ('LEGENDARY', 'ULTIMATE') AND q.bid < 0.5 * q.pre) AS skipped
    FROM q
   WHERE q.bid >= 0.25 * q.pre AND q.bid < q.pre
)
INSERT INTO public.audit_20261126_topshot_offer_pull_restamp_backup
  (snapshot_id, edition_id, tier, bid_usd, old_fmv_usd, new_fmv_usd, old_algo_version, new_algo_version)
SELECT r.id, r.edition_id, r.tier, r.bid, r.fmv, r.new_fmv, r.algo_version,
       CASE WHEN r.skipped THEN regexp_replace(r.algo_version, '_bidpull$', '') ELSE r.algo_version END
  FROM r
 WHERE r.new_fmv > r.fmv
ON CONFLICT (snapshot_id) DO NOTHING;

UPDATE public.fmv_snapshots fs
   SET fmv_usd = b.new_fmv_usd,
       algo_version = b.new_algo_version
  FROM public.audit_20261126_topshot_offer_pull_restamp_backup b
 WHERE fs.id = b.snapshot_id
   AND fs.computed_at >= now() - interval '7 days'
   AND fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND fs.confidence = 'LOW'
   AND fs.fmv_usd = b.old_fmv_usd;