-- audit_20260802_pack_realized_ev_materialize_v2_swap_view
-- Applied to prod 2026-08-02 05:27 UTC / 2026-08-01 22:27 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- Completes audit_20260802_pack_realized_ev_materialize, which created
-- mv_topshot_pack_realized_ev as `SELECT * FROM v_topshot_pack_realized_ev`.
-- That form CANNOT be swapped onto: repointing the view at the MV would make the
-- view depend on an MV that depends on the view. The MV must own the full body
-- (the pattern the three sibling board MVs used). So: drop that MV, rebuild it
-- from the view's verbatim body, then repoint the view.
--
-- WHY: this is the FOURTH leg of /api/public/insights/pack-reality. The sibling
--   migration (audit_20260802_pack_reality_stats_and_top_ev_materialize) left it
--   alone on the strength of a 122 ms measurement. THAT MEASUREMENT WAS WRONG and
--   this comment exists so nobody trusts it again: the probe selected only
--   (dist_id, n_opens), and neither column comes from pack_ev_latest, so the
--   planner ELIDED the pack_ev_latest join entirely. Re-measured with the
--   THIRTEEN columns the route actually selects -- which include modeled_*,
--   price_source and calibrated_ev, all sourced from pack_ev_latest -- the same
--   query is 7,722 ms with shared hit=398,724 (~3.1 GB of buffer traffic).
--   DURABLE LESSON: when profiling a view, select the CALLER'S REAL COLUMN LIST;
--   a narrower projection can prune joins and understate the cost by 60x.
--
-- OBSERVED IMPACT (live, before this migration): a plain request to
--   /api/public/insights/pack-reality (no cache-buster) returned
--   meta.elapsed_ms = 30,248 -- the leg burned the entire 30 s service_role
--   budget and errored. It is NON-FATAL, so the board rendered the
--   "MODEL VS REALITY" section as "NO QUALIFYING PACKS YET" while 184
--   distributions actually qualify -- and Vercel then cached that lie for the
--   full 5-minute s-maxage. A silent wrong answer, not an outage.
--
-- The hot spot is pack_ev_latest: a DISTINCT ON over 200,367 pack_ev_history
--   rows plus a per-row pack_ask_state SubPlan run 66,003 times (193,898
--   buffers) -- the SAME hot spot behind topshot_pack_reality_top_ev. NOTE: the
--   existing mv_pack_ev_latest is deliberately NOT substituted here; the standing
--   rule is that an MV is not the view it mirrors and gross_ev/pack_ev must never
--   be published from mv_pack_ev_latest. Snapshotting THIS view wholesale keeps
--   the published shape and semantics byte-for-byte.
--
-- GRANTS DIFFER FROM THE THREE SIBLING BOARD MVs, ON PURPOSE. Those revoked the
--   MV from anon/authenticated, which (with security_invoker = on) also cuts off
--   any anon read THROUGH the view. Here the view is anon-SELECTable and is read
--   by a second anon-SELECTable security_invoker view, v_topshot_pack_ev_calibrated;
--   an invoker view executes its source AS THE CALLER, so a revoke could 403 that
--   chain. The MV therefore carries the same grants the view already had. No new
--   information is exposed -- the MV holds exactly the rows the view served.
--   (Measured after apply: anon can now actually read v_topshot_pack_realized_ev
--   -- 184 rows -- which it could NOT before, because the old body read
--   pack_ev_latest and anon has no SELECT there. So this is a small INCREASE in
--   reachability of already-public data, not a preservation. Separately,
--   v_topshot_pack_ev_calibrated remains anon-denied because it reads
--   pack_ev_latest directly; that is PRE-EXISTING and untouched here.)
--
-- Unique key: dist_id (verified live -- 184 rows / 184 distinct / 0 null; the
--   view aggregates by dist_id and joins pack_distributions, unique on
--   (dist_id, collection_id)). No now()-relative predicate in the body.
--
-- VERIFIED AFTER APPLY: 7,722 ms -> 0.18 ms; 184 rows unchanged;
--   v_topshot_pack_ev_calibrated still returns 802 rows;
--   check_public_security_invariants() 0, check_anon_write_surface() 0,
--   check_secdef_anon_exec_drift() [].
--
-- REVERT:
--   SELECT cron.unschedule('rpc-refresh-pack-realized-ev');
--   DELETE FROM public.board_mv_refresh_watchlist WHERE matview_name = 'mv_topshot_pack_realized_ev';
--   CREATE OR REPLACE VIEW public.v_topshot_pack_realized_ev AS <the MV body below>;
--   ALTER VIEW public.v_topshot_pack_realized_ev SET (security_invoker = on);
--   GRANT SELECT ON public.v_topshot_pack_realized_ev TO anon, authenticated, service_role;
--   DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_realized_ev;

SET LOCAL statement_timeout = '600s';

DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_realized_ev;

CREATE MATERIALIZED VIEW public.mv_topshot_pack_realized_ev AS
WITH r AS (
  SELECT mv_topshot_pack_rip_values.dist_id,
         mv_topshot_pack_rip_values.pull_value_usd,
         mv_topshot_pack_rip_values.moments_pulled
    FROM mv_topshot_pack_rip_values
), agg AS (
  SELECT r.dist_id,
         count(*) AS n_opens,
         round(avg(r.pull_value_usd), 2) AS realized_mean,
         round(percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r.pull_value_usd::double precision))::numeric, 2) AS realized_median,
         round(percentile_cont(0.1::double precision) WITHIN GROUP (ORDER BY (r.pull_value_usd::double precision))::numeric, 2) AS realized_p10,
         round(percentile_cont(0.9::double precision) WITHIN GROUP (ORDER BY (r.pull_value_usd::double precision))::numeric, 2) AS realized_p90,
         percentile_disc(0.9::double precision) WITHIN GROUP (ORDER BY r.pull_value_usd) AS realized_p90_disc,
         round(max(r.pull_value_usd), 2) AS realized_max,
         round(avg(r.moments_pulled), 2) AS avg_moments
    FROM r
   GROUP BY r.dist_id
), wins AS (
  SELECT r.dist_id,
         round(avg(LEAST(r.pull_value_usd, a.realized_p90_disc)), 2) AS realized_winsorized
    FROM r
    JOIN agg a ON a.dist_id = r.dist_id
   GROUP BY r.dist_id
), ev_one AS (
  SELECT DISTINCT ON (pack_ev_latest.dist_id) pack_ev_latest.dist_id,
         pack_ev_latest.pack_price,
         pack_ev_latest.gross_ev,
         pack_ev_latest.pack_ev,
         pack_ev_latest.value_ratio,
         pack_ev_latest.price_source
    FROM pack_ev_latest
   WHERE pack_ev_latest.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   ORDER BY pack_ev_latest.dist_id, pack_ev_latest.snapshotted_at DESC
)
SELECT agg.dist_id,
       d.title,
       CASE
         WHEN NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric >= 1000000::numeric THEN round(NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric * 0.00000001, 2)
         ELSE NULLIF(d.metadata ->> 'retail_price_usd'::text, ''::text)::numeric
       END AS retail_price_usd,
       ev.pack_price AS modeled_pack_price,
       ev.gross_ev AS modeled_gross_ev,
       ev.pack_ev AS modeled_net_ev,
       ev.price_source,
       agg.n_opens,
       agg.avg_moments,
       agg.realized_mean,
       agg.realized_median,
       agg.realized_p10,
       agg.realized_p90,
       agg.realized_max,
       round(agg.realized_mean - ev.gross_ev, 2) AS realized_minus_modeled,
       CASE
         WHEN ev.gross_ev > 0::numeric THEN round(agg.realized_mean / ev.gross_ev, 3)
         ELSE NULL::numeric
       END AS realized_to_modeled_ratio,
       round(LEAST(0.85, agg.n_opens::numeric / (agg.n_opens + 40)::numeric), 3) AS calibration_weight,
       CASE
         WHEN ev.gross_ev IS NULL THEN w.realized_winsorized
         WHEN agg.realized_mean > 0::numeric AND ev.gross_ev > (3::numeric * agg.realized_mean) THEN w.realized_winsorized
         ELSE round((1::numeric - LEAST(0.85, agg.n_opens::numeric / (agg.n_opens + 40)::numeric)) * ev.gross_ev + LEAST(0.85, agg.n_opens::numeric / (agg.n_opens + 40)::numeric) * w.realized_winsorized, 2)
       END AS calibrated_ev,
       w.realized_winsorized
  FROM agg
  JOIN wins w ON w.dist_id = agg.dist_id
  JOIN pack_distributions d ON d.dist_id = agg.dist_id AND d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
  LEFT JOIN ev_one ev ON ev.dist_id = agg.dist_id
 WHERE agg.n_opens >= 10;

CREATE UNIQUE INDEX IF NOT EXISTS mv_topshot_pack_realized_ev_dist_key
  ON public.mv_topshot_pack_realized_ev (dist_id);

GRANT SELECT ON public.mv_topshot_pack_realized_ev TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.mv_topshot_pack_realized_ev IS
  'Backing store for public.v_topshot_pack_realized_ev. Refreshed hourly by pg_cron rpc-refresh-pack-realized-ev (600s inner budget). Read through the VIEW, never directly. Grants mirror the view (anon SELECT) because v_topshot_pack_ev_calibrated is an anon-readable security_invoker view reading it.';

CREATE OR REPLACE VIEW public.v_topshot_pack_realized_ev AS
SELECT dist_id,
       title,
       retail_price_usd,
       modeled_pack_price,
       modeled_gross_ev,
       modeled_net_ev,
       price_source,
       n_opens,
       avg_moments,
       realized_mean,
       realized_median,
       realized_p10,
       realized_p90,
       realized_max,
       realized_minus_modeled,
       realized_to_modeled_ratio,
       calibration_weight,
       calibrated_ev,
       realized_winsorized
  FROM public.mv_topshot_pack_realized_ev;

ALTER VIEW public.v_topshot_pack_realized_ev SET (security_invoker = on);
GRANT SELECT ON public.v_topshot_pack_realized_ev TO anon, authenticated, service_role;

-- Minute clear of the existing :07 / :12 / :15 / :17 / :27 board-MV refreshes.
SELECT cron.schedule(
  'rpc-refresh-pack-realized-ev',
  '42 * * * *',
  $cmd$SET statement_timeout = '600s'; REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_topshot_pack_realized_ev;$cmd$
);

INSERT INTO public.board_mv_refresh_watchlist (matview_name, max_stale_hours, is_active, note)
VALUES ('mv_topshot_pack_realized_ev', 6, true,
        'backs /insights/pack-reality model-vs-reality + v_topshot_pack_ev_calibrated; pg_cron rpc-refresh-pack-realized-ev 42 * * * * (hourly) -> 6h = 6 missed ticks')
ON CONFLICT (matview_name) DO UPDATE
  SET max_stale_hours = EXCLUDED.max_stale_hours,
      is_active       = EXCLUDED.is_active,
      note            = EXCLUDED.note;
