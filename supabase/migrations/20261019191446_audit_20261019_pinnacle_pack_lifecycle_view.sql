-- audit_20261019: Pinnacle pack pages get the observed-lifecycle and realized-pull panels
--
-- WHY. The pack page's "Observed pack lifecycle" and "Realized pull value" panels read
-- `v_allday_pack_lifecycle` (All Day) or a per-dist RPC (Top Shot); every other collection
-- returns no data, so a Disney Pinnacle pack page showed neither — although
-- `pinnacle_pack_opens` holds the complete open history (91,471 opens, equal to Dapper's
-- index; ledger 10-10) and prices 91,433 of them (`pull_value_usd`, written once by
-- `price_pinnacle_pack_opens` as the sum of the pulled pins' catalog FMV, only when EVERY
-- pull has one). Measured 2026-10-19 ~12:20 PM PT: 99 distributions have >= 5 opens.
--
-- WHAT. One row per Pinnacle distribution with opens: packs opened, moments pulled, how
-- many opens are priced, the total / mean / median priced pull value, and first/last open.
-- A dist whose opens are all unpriced reads NULL value, never 0 (the 08-01
-- "never fabricate zero" rule for this panel). The same valuation basis as All Day's
-- `pack_rips.pull_value_usd`: FMV when the pulls were first fully priceable — for opens
-- from before 2026-09 that is the backfill date, not the open date (the page labels it
-- "realized pull value", as for All Day).
--
-- Posture: read by the pack page through the service-role client only; security_invoker
-- on, no anon/authenticated grants on the view (it is not a public surface).
--
-- REVERT: DROP VIEW public.v_pinnacle_pack_lifecycle;
--
-- anon-exec: n/a — no function is created here; this migration creates one view.

CREATE VIEW public.v_pinnacle_pack_lifecycle
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
  FROM public.pinnacle_pack_opens o
 WHERE o.dist_id IS NOT NULL
 GROUP BY o.dist_id;

REVOKE ALL ON public.v_pinnacle_pack_lifecycle FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_pinnacle_pack_lifecycle TO service_role;

COMMENT ON VIEW public.v_pinnacle_pack_lifecycle IS
  'Per-distribution Pinnacle pack opens and priced pull value from pinnacle_pack_opens (complete open history). Value columns are NULL when no open of the dist is priced. Read by the pack page (lib/pack-dist/fetchers.ts). Built 2026-10-19.';
