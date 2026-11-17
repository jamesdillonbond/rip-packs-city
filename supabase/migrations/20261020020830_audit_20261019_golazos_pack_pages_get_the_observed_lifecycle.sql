-- audit_20261019: Golazos pack pages get the observed-lifecycle and realized-pull panels
--
-- WHY. The pack page's "Observed pack lifecycle" and "Realized pull value" panels have
-- sources for Top Shot, All Day and (since 20261019191446) Disney Pinnacle; a LaLiga
-- Golazos pack page showed neither, although `golazos_pack_opens` holds the complete open
-- history. Measured 2026-10-19 ~7:15 PM PT: 78,830 opens over 202 distributions, equal to
-- the `total_api` Dapper's index reports to `golazos-pack-opens-ingest` on every run; 78,821
-- priced. `price_golazos_pack_opens` writes `pull_value_usd` once, as the sum of the pulled
-- moments' latest FMV, and only when EVERY pull has one (HAVING count(*) =
-- count(fmv) = moments_pulled), so a priced open is never a partial sum.
--
-- WHAT. The same shape as `v_pinnacle_pack_lifecycle`: one row per Golazos distribution
-- with opens — packs opened, moments pulled, priced opens, total / mean / median priced
-- pull value, first/last open. Value columns are NULL when no open is priced, never 0.
-- Valuation basis: FMV when the pulls were priced, which for most opens is years after
-- the open (median ~1,295 days, read 10-19). So the page shows the realized pull
-- distribution ALONE, never a ratio against the modeled EV of the remaining pool.
--
-- Posture: read by the pack page through the service-role client only; security_invoker
-- on, no anon/authenticated grants on the view (it is not a public surface).
--
-- REVERT: DROP VIEW public.v_golazos_pack_lifecycle;
--
-- anon-exec: n/a — no function is created here; this migration creates one view.

CREATE VIEW public.v_golazos_pack_lifecycle
WITH (security_invoker = on) AS
SELECT o.dist_id,
       count(*)                                                    AS packs_opened,
       sum(o.moments_pulled)                                       AS moments_pulled,
       count(o.pull_value_usd)                                     AS n_valued,
       round(sum(o.pull_value_usd), 2)                             AS realized_pull_value_usd,
       round(avg(o.pull_value_usd), 2)                             AS avg_realized_value_per_pack,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pull_value_usd))::numeric, 2) AS realized_median,
       min(o.opened_at)                                            AS first_open_at,
       max(o.opened_at)                                            AS last_open_at
  FROM public.golazos_pack_opens o
 WHERE o.dist_id IS NOT NULL
 GROUP BY o.dist_id;

REVOKE ALL ON public.v_golazos_pack_lifecycle FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_golazos_pack_lifecycle TO service_role;

COMMENT ON VIEW public.v_golazos_pack_lifecycle IS
  'Per-distribution Golazos pack opens and priced pull value from golazos_pack_opens (complete open history). Value columns are NULL when no open of the dist is priced. Read by the pack page (lib/pack-dist/fetchers.ts). Built 2026-10-19.';
