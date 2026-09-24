-- audit_20260924_pack_ev_backtest_excludes_zero_pull_residue
--
-- pack_ev_backtest (20260924054525) counted pack_rips.pull_value_usd = 0 as a real pull.
-- The column's own comment says "0 is NOT a valid value from either writer as of
-- 2026-09-20; a 0 found here is residue of the pre-2026-09-20 backfill". Measured
-- 2026-09-24 ~7:50 AM PT: 17,510 of 25,474 Top Shot rips in the 30-day window are 0
-- (newest 2026-09-20), so 5 of the view's 10 Top Shot rows read realized_median 0.00
-- (typical_to_realized_median NULL) and their gross_to_realized_mean was inflated
-- (dist 5305 26.6x, 1201 10.4x). The zeros also counted toward the >= 20-opens
-- threshold, and the header's "Top Shot 1.31x" first read carried them.
--
-- CHANGE: the pack_rips leg requires pull_value_usd > 0. Golazos / Pinnacle legs are
-- unchanged (0 zeros measured in their windows). Output columns, joins and threshold
-- are unchanged; the comment now says realized value is the CURRENT FMV of the pulls
-- (it read "at pricing time", which the column comment contradicts, register #92).
-- WITH (security_invoker = on) is restated because CREATE OR REPLACE VIEW resets
-- reloptions; the ACL (service_role SELECT only) is preserved by CREATE OR REPLACE.
--
-- REVERT: re-apply the view body from 20260924054525 (IS NOT NULL on the pack_rips leg).

CREATE OR REPLACE VIEW public.pack_ev_backtest WITH (security_invoker = on) AS
WITH opens AS (
  SELECT r.collection_id, r.dist_id, r.pull_value_usd AS v
  FROM public.pack_rips r
  WHERE r.pull_value_usd > 0 AND r.dist_id IS NOT NULL
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

ALTER VIEW public.pack_ev_backtest SET (security_invoker = on);

COMMENT ON VIEW public.pack_ev_backtest IS
  'Published pack EV (pack_ev_latest) vs realized pull value of priced opens in the last 30 days, per dist with >= 20 opens. Realized = the CURRENT FMV of the pulls (pack_rips.pull_value_usd, register #92); pack_rips rows at 0 are pre-2026-09-20 backfill residue and are excluded. The 30-day mean under-samples rare hits. Gate for any EV weighting change. 2026-09-23, zero-residue fix 2026-09-24.';
