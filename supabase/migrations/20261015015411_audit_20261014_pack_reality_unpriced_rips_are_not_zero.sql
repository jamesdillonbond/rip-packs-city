-- audit_20261014 — Pack Reality: a rip whose value was never computed is NOT a
-- $0 pull.
--
-- WHAT WAS WRONG. mv_topshot_pack_reality_stats and _dist both read
-- `COALESCE(pack_rips.pull_value_usd, 0)`, so every rip the pricer could not
-- value counted as a pack that "delivered nothing". Measured 2026-10-14 ~7:10 PM
-- PT over the 60-day Top Shot window: 63,212 rips, 56,200 priced, 7,012 with a
-- NULL pull value — and ZERO with an actual $0 value. So the public board's
-- headline "11% delivered nothing", its "Delivered $0" KPI, its "$0" histogram
-- bar and the /insights hub card "11% of rips pull $0" were 100 % fabricated,
-- and the mean / median / p90 / p99 were dragged down by 7,012 invented zeros.
-- The NULLs are spread across every week (342 … 3,369 per week), so they are
-- rips the pricer cannot value, not a backlog that will fill.
--
-- THE CHANGE (new objects only — the old ones are harmless once nothing reads
-- them, and the MCP write gate refuses removals):
--   1. mv_topshot_pack_reality_stats_v2: value statistics over PRICED rips
--      only; rips_60d still counts every rip; three columns APPENDED:
--      priced_rips, unpriced_rips, unpriced_pct. zero_value_* now counts real
--      $0 pulls among priced rips.
--   2. mv_topshot_pack_reality_dist_v2: the same six buckets over priced rips,
--      pct of priced rips.
--   3. topshot_pack_reality_stats / _dist (the public, security_invoker views)
--      repointed to v2 — same columns in the same order, the three new ones
--      appended to stats — with security_invoker restated (CREATE OR REPLACE
--      VIEW resets reloptions).
--   4. pg_cron 240 / 237 refresh the v2 MVs (same schedules, same CONCURRENTLY
--      refresh, which needs the unique index on ord).
--   Grants mirror the originals: the MVs are service-role only (the public
--   route reads with the service role); anon/authenticated never read them.
--
-- RESIDUE: mv_topshot_pack_reality_stats and mv_topshot_pack_reality_dist (v1)
-- are no longer read or refreshed; remove them from the dashboard SQL editor
-- when convenient.
--
-- REVERT: CREATE OR REPLACE the two views onto the v1 MVs (their v1 column
-- lists, i.e. without the three appended stats columns, is NOT possible with
-- CREATE OR REPLACE — re-create them from scratch instead), point jobs 240 / 237
-- back at the v1 MVs with cron.alter_job, and REFRESH the v1 MVs once.

CREATE MATERIALIZED VIEW public.mv_topshot_pack_reality_stats_v2 AS
WITH rips AS (
  SELECT pack_rips.pull_value_usd AS pv
  FROM public.pack_rips
  WHERE pack_rips.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND pack_rips.sealed_at >= (now() - '60 days'::interval)
), totals AS (
  SELECT count(*) AS n_all FROM rips
), priced AS (
  SELECT pv FROM rips WHERE pv IS NOT NULL
)
SELECT 1 AS ord,
  (SELECT n_all FROM totals) AS rips_60d,
  count(*) FILTER (WHERE pv = 0::numeric) AS zero_value_rips,
  round(100.0 * (count(*) FILTER (WHERE pv = 0::numeric))::numeric / NULLIF(count(*), 0)::numeric, 1) AS zero_value_pct,
  round(avg(pv), 2) AS mean_pull_value_usd,
  round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (pv::double precision)))::numeric, 2) AS median_pull_value_usd,
  round((percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (pv::double precision)))::numeric, 2) AS p90_pull_value_usd,
  round((percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (pv::double precision)))::numeric, 2) AS p99_pull_value_usd,
  count(*) FILTER (WHERE pv > 100::numeric) AS rips_over_100,
  round(100.0 * (count(*) FILTER (WHERE pv > 100::numeric))::numeric / NULLIF(count(*), 0)::numeric, 2) AS rips_over_100_pct,
  count(*) FILTER (WHERE pv > 1000::numeric) AS rips_over_1000,
  now() AS computed_at,
  count(*) AS priced_rips,
  (SELECT n_all FROM totals) - count(*) AS unpriced_rips,
  round(100.0 * ((SELECT n_all FROM totals) - count(*))::numeric / NULLIF((SELECT n_all FROM totals), 0)::numeric, 1) AS unpriced_pct
FROM priced;

CREATE UNIQUE INDEX mv_topshot_pack_reality_stats_v2_ord_key
  ON public.mv_topshot_pack_reality_stats_v2 USING btree (ord);

CREATE MATERIALIZED VIEW public.mv_topshot_pack_reality_dist_v2 AS
WITH rips AS (
  SELECT pack_rips.pull_value_usd AS pv
  FROM public.pack_rips
  WHERE pack_rips.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND pack_rips.sealed_at >= (now() - '60 days'::interval)
    AND pack_rips.pull_value_usd IS NOT NULL
), total AS (
  SELECT count(*)::numeric AS n FROM rips
)
SELECT 1 AS ord, '$0'::text AS bucket, 0::numeric AS lower_bound, 0::numeric AS upper_bound,
  count(*) FILTER (WHERE rips.pv = 0::numeric) AS rips,
  round(100.0 * (count(*) FILTER (WHERE rips.pv = 0::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1) AS pct
FROM rips
UNION ALL
SELECT 2, '$0–$10'::text, 0.01, 10,
  count(*) FILTER (WHERE rips.pv > 0::numeric AND rips.pv <= 10::numeric),
  round(100.0 * (count(*) FILTER (WHERE rips.pv > 0::numeric AND rips.pv <= 10::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
FROM rips
UNION ALL
SELECT 3, '$10–$50'::text, 10.01, 50,
  count(*) FILTER (WHERE rips.pv > 10::numeric AND rips.pv <= 50::numeric),
  round(100.0 * (count(*) FILTER (WHERE rips.pv > 10::numeric AND rips.pv <= 50::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
FROM rips
UNION ALL
SELECT 4, '$50–$100'::text, 50.01, 100,
  count(*) FILTER (WHERE rips.pv > 50::numeric AND rips.pv <= 100::numeric),
  round(100.0 * (count(*) FILTER (WHERE rips.pv > 50::numeric AND rips.pv <= 100::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
FROM rips
UNION ALL
SELECT 5, '$100–$1k'::text, 100.01, 1000,
  count(*) FILTER (WHERE rips.pv > 100::numeric AND rips.pv <= 1000::numeric),
  round(100.0 * (count(*) FILTER (WHERE rips.pv > 100::numeric AND rips.pv <= 1000::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
FROM rips
UNION ALL
SELECT 6, '$1k+'::text, 1000.01, NULL::numeric,
  count(*) FILTER (WHERE rips.pv > 1000::numeric),
  round(100.0 * (count(*) FILTER (WHERE rips.pv > 1000::numeric))::numeric / NULLIF((SELECT total.n FROM total), 0::numeric), 1)
FROM rips;

CREATE UNIQUE INDEX mv_topshot_pack_reality_dist_v2_ord_key
  ON public.mv_topshot_pack_reality_dist_v2 USING btree (ord);

REVOKE ALL ON public.mv_topshot_pack_reality_stats_v2 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.mv_topshot_pack_reality_dist_v2 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_topshot_pack_reality_stats_v2 TO service_role;
GRANT SELECT ON public.mv_topshot_pack_reality_dist_v2 TO service_role;

CREATE OR REPLACE VIEW public.topshot_pack_reality_stats WITH (security_invoker = on) AS
SELECT rips_60d,
  zero_value_rips,
  zero_value_pct,
  mean_pull_value_usd,
  median_pull_value_usd,
  p90_pull_value_usd,
  p99_pull_value_usd,
  rips_over_100,
  rips_over_100_pct,
  rips_over_1000,
  computed_at,
  priced_rips,
  unpriced_rips,
  unpriced_pct
FROM public.mv_topshot_pack_reality_stats_v2;

CREATE OR REPLACE VIEW public.topshot_pack_reality_dist WITH (security_invoker = on) AS
SELECT bucket,
  lower_bound,
  upper_bound,
  rips,
  pct
FROM public.mv_topshot_pack_reality_dist_v2
ORDER BY ord;

SELECT cron.alter_job(240, command := $c$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_stats_v2;$c$);
SELECT cron.alter_job(237, command := $c$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_dist_v2;$c$);
