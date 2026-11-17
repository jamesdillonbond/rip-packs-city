-- pack_ev_backtest — published pack EV vs what packs actually pulled (2026-09-23).
--
-- WHY: pack EV is the product's headline claim and had no instrument measuring
-- it against outcomes. RPC now holds priced opens for four collections
-- (pack_rips: Top Shot + All Day; golazos_pack_opens; pinnacle_pack_opens), so
-- the claim is checkable. One row per (collection, dist) with >= 20 priced opens
-- in the last 30 days: realized mean/median pull value against the latest
-- published gross_ev / typical_ev from pack_ev_latest.
--
-- First read (2026-09-23 ~10:50 PM PT, 30-day window): Top Shot 11 dists,
-- published gross EV a median 1.31x the realized mean; All Day 4 dists, 2.70x.
-- Typical (median) EV sits much closer (median abs error 3.8% TS, 41.7% All Day).
-- An out-of-sample test of EMPIRICAL pull weights for All Day (odds learned from
-- opens older than 21 days) was MIXED on the 4 dists with enough test opens
-- (better on 2, equal on 1, far worse on 1), so the published EV method is NOT
-- changed: this view is the gate a future weighting change must pass.
--
-- CAVEATS carried in the columns, not hidden: realized value is the FMV of the
-- pulls at pricing time (all-or-nothing per pack), not a sale; a 30-day window
-- under-samples rare hits, so realized MEAN is biased LOW against a true
-- expectation — compare typical_ev to realized_median first.
--
-- REVERT: DROP VIEW public.pack_ev_backtest;

CREATE VIEW public.pack_ev_backtest WITH (security_invoker = on) AS
WITH opens AS (
  SELECT r.collection_id, r.dist_id, r.pull_value_usd AS v
  FROM public.pack_rips r
  WHERE r.pull_value_usd IS NOT NULL AND r.dist_id IS NOT NULL
    AND r.sealed_at > now() - interval '30 days'
  UNION ALL
  SELECT '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid, g.dist_id, g.pull_value_usd
  FROM public.golazos_pack_opens g
  WHERE g.pull_value_usd IS NOT NULL AND g.dist_id IS NOT NULL
    AND g.opened_at > now() - interval '30 days'
  UNION ALL
  SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid, p.dist_id, p.pull_value_usd
  FROM public.pinnacle_pack_opens p
  WHERE p.pull_value_usd IS NOT NULL AND p.dist_id IS NOT NULL
    AND p.opened_at > now() - interval '30 days'
),
realized AS (
  SELECT collection_id, dist_id, count(*) AS priced_opens,
         avg(v) AS realized_mean,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS realized_median
  FROM opens
  GROUP BY 1, 2
  HAVING count(*) >= 20
),
ev AS (
  SELECT DISTINCT ON (collection_id, dist_id)
         collection_id, dist_id, pack_name, gross_ev, typical_ev, snapshotted_at
  FROM public.pack_ev_latest
  WHERE gross_ev IS NOT NULL
  ORDER BY collection_id, dist_id, snapshotted_at DESC
)
SELECT c.slug AS collection_slug,
       r.dist_id,
       ev.pack_name,
       r.priced_opens,
       round(r.realized_mean::numeric, 2)   AS realized_mean,
       round(r.realized_median::numeric, 2) AS realized_median,
       ev.gross_ev   AS published_gross_ev,
       ev.typical_ev AS published_typical_ev,
       round((ev.gross_ev / NULLIF(r.realized_mean, 0))::numeric, 3)     AS gross_to_realized_mean,
       round((ev.typical_ev / NULLIF(r.realized_median, 0))::numeric, 3) AS typical_to_realized_median,
       ev.snapshotted_at AS ev_snapshotted_at
FROM realized r
JOIN ev USING (collection_id, dist_id)
JOIN public.collections c ON c.id = r.collection_id;

COMMENT ON VIEW public.pack_ev_backtest IS
  'Published pack EV (pack_ev_latest) vs realized pull value of priced opens in the last 30 days, per dist with >= 20 opens. Realized = FMV of pulls at pricing time; the 30-day mean under-samples rare hits. Gate for any EV weighting change. 2026-09-23.';

REVOKE ALL ON public.pack_ev_backtest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pack_ev_backtest TO service_role;
