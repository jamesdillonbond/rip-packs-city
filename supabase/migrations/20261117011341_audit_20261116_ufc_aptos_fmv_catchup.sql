-- 2026-11-16 ~5:15 PM PT (Claude Code, laptop; Trevor: "Do what you think is best")
--
-- UFC Strike: re-price the 458 editions whose newest FMV snapshot predates the
-- Aptos sales backfilled for them on 11-15/11-16 (source 'aptos_indexer_v1').
--
-- Why: every one of them is STALE and was priced from Flow history only, before
-- the Aptos history landed, so the binder values them far from what they trade
-- for (e.g. Khabib UFC 205 Submission /148: FMV $0.01 vs Aptos sales $21.60 /
-- $57.96 / $25.20). drain_fmv_cold_tail would re-price them with exactly this
-- rule, but only once each snapshot is > 7 days old (~11-20 to 11-22), and the
-- main sweep never sees them (no sale in 30 days; hot lane keys on sold_at).
--
-- What: one INSERT per edition, the SAME row drain_fmv_cold_tail writes on its
-- history branch (median of the last 30 paid sales kept within 90 days of the
-- newest, never fewer than the 3 most recent; STALE; algo 'cold-tail-1.0').
-- Insert-only, like the drain: older snapshots are untouched, readers take the
-- newest. Editions with a 30-day sale are skipped (the main sweep owns them).
-- Measured before writing: 458 rows, all STALE now and after; 62 unchanged,
-- 140 up > 2x, 23 down > 2x; sum $2,941.31 -> $5,129.76.
--
-- Revert:
--   DELETE FROM public.fmv_snapshots f
--   USING public.audit_20261116_ufc_aptos_fmv_catchup a
--   WHERE f.id = a.snapshot_id AND f.computed_at = a.computed_at;

CREATE TABLE IF NOT EXISTS public.audit_20261116_ufc_aptos_fmv_catchup (
  snapshot_id  uuid PRIMARY KEY,
  edition_id   uuid NOT NULL,
  computed_at  timestamptz NOT NULL,
  old_fmv_usd  numeric,
  new_fmv_usd  numeric
);
ALTER TABLE public.audit_20261116_ufc_aptos_fmv_catchup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261116_ufc_aptos_fmv_catchup FROM PUBLIC, anon, authenticated;

WITH c AS (
  SELECT id FROM public.collections WHERE slug = 'ufc_strike'
),
a AS (
  SELECT s.edition_id, max(s.ingested_at) AS ing
  FROM public.sales s, c
  WHERE s.collection_id = c.id AND s.source = 'aptos_indexer_v1'
  GROUP BY 1
),
cur AS (
  SELECT DISTINCT ON (f.edition_id) f.edition_id, f.fmv_usd, f.computed_at
  FROM public.fmv_snapshots f, c
  WHERE f.collection_id = c.id AND f.edition_id IN (SELECT edition_id FROM a)
  ORDER BY f.edition_id, f.computed_at DESC
),
t AS (
  SELECT a.edition_id, cur.fmv_usd AS old_fmv
  FROM a JOIN cur USING (edition_id)
  WHERE cur.computed_at < a.ing
    AND NOT EXISTS (
      SELECT 1 FROM public.sales_market m
      WHERE m.edition_id = a.edition_id
        AND m.sold_at > now() - interval '30 days'
        AND m.price_usd > 0
    )
),
h AS (
  SELECT t.edition_id, t.old_fmv, x.med, x.floor_px, x.last_sold, x.n
  FROM t
  CROSS JOIN LATERAL (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.price_usd) AS med,
           min(r.price_usd) AS floor_px, max(r.sold_at) AS last_sold, count(*) AS n
    FROM (
      SELECT l.price_usd, l.sold_at,
             row_number() OVER (ORDER BY l.sold_at DESC) AS rn,
             max(l.sold_at) OVER () AS newest
      FROM (
        SELECT price_usd, sold_at FROM public.sales_market
        WHERE edition_id = t.edition_id AND price_usd > 0
        ORDER BY sold_at DESC LIMIT 30
      ) l
    ) r
    WHERE r.rn <= 3 OR r.sold_at >= r.newest - interval '90 days'
  ) x
  WHERE x.n > 0
),
ins AS (
  INSERT INTO public.fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, asp_without_outliers,
    confidence, sales_count_7d, sales_count_30d, days_since_sale,
    algo_version, computed_at, collection
  )
  SELECT h.edition_id, c.id,
         round(h.med::numeric, 2), round(h.floor_px::numeric, 2), round(h.med::numeric, 2), round(h.med::numeric, 2),
         'STALE', 0, 0, extract(day FROM now() - h.last_sold)::int,
         'cold-tail-1.0', now(), 'ufc_strike'
  FROM h, c
  RETURNING id, edition_id, computed_at, fmv_usd
)
INSERT INTO public.audit_20261116_ufc_aptos_fmv_catchup (snapshot_id, edition_id, computed_at, old_fmv_usd, new_fmv_usd)
SELECT ins.id, ins.edition_id, ins.computed_at, h.old_fmv, ins.fmv_usd
FROM ins JOIN h USING (edition_id);
