-- 2026-11-17 (Claude Code, Trevor's laptop, ~3:21 PM PT; Trevor: "Keep going and doing what you can").
--
-- The Top Shot pack-reality board's "why is the ranker empty" leg reads
-- v_topshot_pack_reality_ranker_staleness, which re-derives the latest pack_ev_history row per
-- listing across EVERY collection (DISTINCT ON over ~703k rows, a 65 MB on-disk sort) before
-- filtering to Top Shot. Measured 11-17 ~3:15 PM PT: 18.4 s cold, 11.4 s warm, ~36k blocks read
-- from disk either way — against the route's 8 s bound. The leg runs only when the ranker is empty
-- (it is), and a failed read is served `no-store`, so EVERY visit re-ran it and failed: the honest
-- "N packs would qualify but are stale" explanation could never render (Vercel: 5 RPC_READ_TIMEOUT
-- on this leg in the 12 h to 3:09 PM PT). A cache cannot fix a read that always fails; the READ is
-- the lever.
--
-- NOW: the view's ONE-row answer is materialized, unchanged, with computed_at, refreshed 4 minutes
-- after the ranker it explains (job 241 `rpc-refresh-pack-reality-top-ev`, :34 every 2 h) at :38
-- every 2 h. CONCURRENTLY (constant unique key k) so a refresh never blocks a reader. The route reads
-- the snapshot. Not changed: the view itself and pack_ev_latest (15 dependents; Top Shot is 74 % of
-- pack_ev_history, so scoping the DISTINCT ON alone would not bring it under the bound).
-- Trade-off: the 48 h freshness window is evaluated at computed_at (≤ ~2 h old), carried in the row.
--
-- ACL: same as the view — service_role SELECT only (the route uses the service client); anon and
-- authenticated get nothing (the MV-anon-readable security arm stays empty).
--
-- Read back after apply (20261117232134): one row, computed_at 3:21 PM PT, 0 candidates (the board is empty
-- because nothing qualifies, not because of staleness); anon SELECT false, service_role true; pg_cron job 892
-- (postgres); check_public_security_invariants() still [].
--
-- Revert: SELECT cron.unschedule('rpc-refresh-pack-reality-ranker-staleness');
--         DROP MATERIALIZED VIEW public.mv_topshot_pack_reality_ranker_staleness;
--         then point lib/insights/topshot-pack-reality.ts back at the view (git revert the code commit).

CREATE MATERIALIZED VIEW public.mv_topshot_pack_reality_ranker_staleness AS
  SELECT 1 AS k, now() AS computed_at, s.*
  FROM public.v_topshot_pack_reality_ranker_staleness s;

CREATE UNIQUE INDEX mv_topshot_pack_reality_ranker_staleness_k
  ON public.mv_topshot_pack_reality_ranker_staleness (k);

REVOKE ALL ON public.mv_topshot_pack_reality_ranker_staleness FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_topshot_pack_reality_ranker_staleness TO service_role;

SELECT cron.schedule(
  'rpc-refresh-pack-reality-ranker-staleness',
  '38 */2 * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_reality_ranker_staleness;$cmd$
);
