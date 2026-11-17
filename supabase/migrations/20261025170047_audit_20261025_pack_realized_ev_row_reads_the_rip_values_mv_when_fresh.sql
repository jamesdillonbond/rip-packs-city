-- audit_20261025_pack_realized_ev_row_reads_the_rip_values_mv_when_fresh
--
-- 2026-10-25 ~10:30 AM PT (Claude Code cloud; Trevor: "work on roadmap and known issues. Fix any issues you encounter").
--
-- WHAT. Vercel's error groups carry `[pack-detail/pack_realized_ev] read exceeded 5000ms` (first seen
-- 08-23, last 10-25 8:53 AM PT) — the pack page's realized-vs-modeled EV row timing out. pgss for
-- get_pack_realized_ev_row: 81,277 calls, mean 461 ms, stddev 2,334 ms, max 29,990 ms, ~9,583 buffers/call.
-- EXPLAIN (ANALYZE, BUFFERS) for the largest dist (8783, 10,052 attributed rips), cold: 11,057 ms, of which
-- the `r` leg is 10,690 ms / 17,579 buffers (4,277 read from disk) — ~10k scattered probes into pack_rips.
-- 20260831163201 already moved that leg to one ordered index scan and 20261004150500 covered it; what is
-- left is disk latency on scattered pages, not plan shape.
--
-- mv_topshot_pack_rip_values ALREADY materialises exactly that leg — `topshot_pack_rip_attribution JOIN
-- pack_rips ON pr.id = a.rip_id WHERE pr.pull_value_usd IS NOT NULL` (rip_id, dist_id, pull_value_usd) —
-- refreshed every 6 h (pg_cron rpc-refresh-topshot-pack-rip-values, `5 */6 * * *`, cron_heavy) and indexed
-- on dist_id. The same read there for dist 8783: 12 ms / 480 buffers. The hourly mv_topshot_pack_realized_ev
-- (the public pack-reality board) is built from it, so the page now agrees with the board.
--
-- LAG, MEASURED (4.7 h into a refresh cycle, all 1,229 dists, live vs MV): 13 dists differ in count (max 11
-- opens), 56 in sum (re-priced pulls); 0 cross the n_opens >= 10 gate either way; the worst mean gap on a
-- dist with >= 10 opens is 8.9 % (dist 7368, 11 vs 10 opens), the next 4.7 %. Bounded by the refresh period.
--
-- ⚠ A STALE PRECOMPUTE MUST NOT RENDER AS CURRENT. The refresh logged nothing, so a stuck MV was invisible.
-- Now (1) refresh_topshot_pack_rip_values() logs `topshot-pack-rip-values` to pipeline_runs (ok=false with
-- SQLERRM on failure — it swallows so the log row survives, like refresh_panini_league_coverage), (2) the
-- lane is on pipeline_cadence_watchlist, and (3) get_pack_realized_ev_row reads the MV ONLY while a
-- successful refresh started within 13 h (two missed cycles); otherwise it falls back to the old live read,
-- byte-for-byte the previous `r` leg. Until the first logged refresh lands, every call takes the live
-- branch — i.e. no behaviour change at apply time.
--
-- NOT CHANGED: agg / wins / ev, the >= 10 gate, the winsorising branch, signature, RETURNS, STABLE,
-- SECURITY DEFINER, search_path, ACLs.
--
-- CONTROL (ledger): in a rolled-back txn, with the freshness row deleted the new function equals the old one
-- on sampled dists (live branch); with it present, dist 8783 runs in ms and differs only by the measured lag.
--
-- REVERT:
--   CREATE OR REPLACE get_pack_realized_ev_row from 20260831163201 (live prosrc md5 before this migration:
--   8fab815a9c02d5e2c75488f5605cf4ac);
--   CREATE OR REPLACE refresh_topshot_pack_rip_values() as the bare `refresh materialized view concurrently`;
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-pack-rip-values';
--
-- anon-exec: unchanged (get_pack_realized_ev_row) — CREATE OR REPLACE, same signature; ACL preserved (postgres + service_role), anon false verified 10-25.
-- anon-exec: unchanged (refresh_topshot_pack_rip_values) — CREATE OR REPLACE, same signature; ACL preserved (postgres, service_role, cron_heavy).

CREATE OR REPLACE FUNCTION public.refresh_topshot_pack_rip_values()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_rip_values;
  SELECT count(*) INTO v_rows FROM public.mv_topshot_pack_rip_values;
  PERFORM public.log_pipeline_run('topshot-pack-rip-values', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refreshed to 0 rows' END,
    'nba-top-shot', NULL, NULL, jsonb_build_object('reads', 'get_pack_realized_ev_row, mv_topshot_pack_realized_ev'));
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('topshot-pack-rip-values', v_started, 0, 0, 0, false, SQLERRM,
    'nba-top-shot', NULL, NULL, jsonb_build_object('sqlstate', SQLSTATE));
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_pack_realized_ev_row(p_dist_id text)
 RETURNS TABLE(modeled_gross_ev numeric, n_opens bigint, realized_mean numeric, realized_median numeric, realized_p90 numeric, realized_to_modeled_ratio numeric, calibrated_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fresh AS (
    SELECT EXISTS (
      SELECT 1 FROM pipeline_runs pr
      WHERE pr.pipeline = 'topshot-pack-rip-values' AND pr.ok
        AND pr.started_at > now() - interval '13 hours') AS ok
  ),
  r AS (
    SELECT v.pull_value_usd
    FROM mv_topshot_pack_rip_values v
    WHERE (SELECT ok FROM fresh) AND v.dist_id = p_dist_id
    UNION ALL
    SELECT pr.pull_value_usd
    FROM pack_rips pr
    WHERE NOT (SELECT ok FROM fresh)
      AND pr.id = ANY (ARRAY(
            SELECT a.rip_id FROM topshot_pack_rip_attribution a WHERE a.dist_id = p_dist_id))
      AND pr.pull_value_usd IS NOT NULL
  ),
  agg AS (
    SELECT count(*) AS n_opens,
           round(avg(pull_value_usd), 2) AS realized_mean,
           round((percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY pull_value_usd::double precision))::numeric, 2) AS realized_median,
           round((percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY pull_value_usd::double precision))::numeric, 2) AS realized_p90,
           percentile_disc(0.9::double precision) WITHIN GROUP (ORDER BY pull_value_usd) AS realized_p90_disc
    FROM r
  ),
  wins AS (
    SELECT round(avg(LEAST(r.pull_value_usd, agg.realized_p90_disc)), 2) AS realized_winsorized
    FROM r, agg
  ),
  ev AS (
    SELECT pel.gross_ev FROM pack_ev_latest pel
    WHERE pel.pack_listing_id = ANY (ARRAY(
            SELECT DISTINCT h.pack_listing_id FROM pack_ev_history h
            WHERE h.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND h.dist_id = p_dist_id))
      AND pel.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pel.dist_id = p_dist_id
    ORDER BY pel.snapshotted_at DESC LIMIT 1
  )
  SELECT ev.gross_ev, agg.n_opens, agg.realized_mean, agg.realized_median, agg.realized_p90,
         CASE WHEN ev.gross_ev > 0 THEN round(agg.realized_mean / ev.gross_ev, 3) END,
         CASE WHEN ev.gross_ev IS NULL THEN wins.realized_winsorized
              WHEN agg.realized_mean > 0 AND ev.gross_ev > 3 * agg.realized_mean THEN wins.realized_winsorized
              ELSE round((1 - LEAST(0.85, agg.n_opens::numeric / (agg.n_opens + 40)::numeric)) * ev.gross_ev
                       + LEAST(0.85, agg.n_opens::numeric / (agg.n_opens + 40)::numeric) * wins.realized_winsorized, 2)
         END
  FROM agg CROSS JOIN wins LEFT JOIN ev ON true
  WHERE agg.n_opens >= 10;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_pack_realized_ev_row(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pack_realized_ev_row(text) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.refresh_topshot_pack_rip_values() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_topshot_pack_rip_values() TO postgres, service_role, cron_heavy;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('topshot-pack-rip-values', 420, 'high',
  'pg_cron rpc-refresh-topshot-pack-rip-values (5 */6 * * * UTC, cron_heavy) -> refresh_topshot_pack_rip_values(), which logs itself. Feeds get_pack_realized_ev_row (the pack page EV row; it falls back to a slow live read once no ok run started in 13 h) and the hourly mv_topshot_pack_realized_ev (pack-reality board). audit_20261025.',
  true, 780)
ON CONFLICT (pipeline) DO NOTHING;

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.get_pack_realized_ev_row(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_pack_realized_ev_row(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refresh_topshot_pack_rip_values()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
  IF NOT has_function_privilege('cron_heavy', 'public.refresh_topshot_pack_rip_values()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cron_heavy lost EXECUTE on refresh_topshot_pack_rip_values -- the pg_cron job would fail';
  END IF;
END
$mig$;
