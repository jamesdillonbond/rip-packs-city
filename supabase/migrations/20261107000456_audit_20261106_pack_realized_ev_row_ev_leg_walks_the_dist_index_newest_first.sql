-- audit_20261106_pack_realized_ev_row_ev_leg_walks_the_dist_index_newest_first
--
-- 2026-11-06 ~4:30 PM PT (Claude Code cloud; Trevor: "Keep going"). The daytime pass's P2:
-- `get_pack_realized_ev_row` still overruns the pack page's 5 s bound (~4/day on
-- /[collection]/pack/dist/*). The rip leg went to an MV on 10-25 (20261025170047); what is left is the
-- `ev` leg.
--
-- MEASURED. EXPLAIN (ANALYZE, BUFFERS), dist 8783, cold: the ev leg alone = 1,470 ms, 2,694 hit + 660 READ.
-- Its InitPlan (SELECT DISTINCT pack_listing_id … WHERE collection, dist) walks EVERY history row of the
-- dist to find its listings — 644 rows on 653 heap blocks, ~1 block per row, 1.46 s of disk — then the
-- view's DISTINCT ON re-reads the same 644 rows. Top Shot history is 844,549 rows over 1,031 dists
-- (~820/dist) and grows with every snapshot, so the cold cost GROWS with time. The answer it needs is ONE
-- row: the newest view row of this dist.
--
-- FIX. Read that row directly: pack_ev_latest's FROM … WHERE copied VERBATIM, plus
-- `collection_id = TS AND dist_id = p_dist_id`, ORDER BY snapshotted_at DESC LIMIT 1 — a backward walk of
-- idx_pack_ev_history_collection_dist_time that stops at the first row passing the guards.
-- Same dist 8783: 17 buffers (1 read), 0.95 ms.
--
-- EQUIVALENCE, PROVED OVER THE POPULATION (not argued). The view applies every guard in WHERE, BEFORE its
-- DISTINCT ON (pack_listing_id), so its row per listing is that listing's newest PASSING row; the old leg
-- took the newest of those among the dist's listings = the newest passing row of the dist, PROVIDED a
-- listing never spans two dists (Top Shot: 0 listings with > 1 dist_id, read live). Full-population diff,
-- one statement, every Top Shot dist: old (view, newest per dist) vs new (this leg): 1,018 dists in both,
-- 0 value differences, 0 snapshotted_at differences, 0 ties at the newest timestamp; the only rows on one
-- side are dist_id IS NULL, which `dist_id = p_dist_id` can never select. The `gross_ev` expression is the
-- view's own sentinel CASE and numeric(10,2) cast. `pack_listing_id` is added as a tiebreak the old leg
-- lacked (0 ties today; it makes a future tie deterministic instead of arbitrary).
--
-- ⚠ WHY THE 08-30 MIGRATION KEPT THE VIEW, AND WHAT REPLACES THAT. 20260830032541 deliberately read
-- pack_ev_latest — "the one source of truth for the publish guards" — rather than hand-copy them, the way
-- get_pack_market_row drifted. The copy here is VERBATIM, and
-- __tests__/pack-realized-ev-row-ev-leg-mirrors-pack-ev-latest.test.ts reds the build if the view's newest
-- migration changes its FROM … WHERE or its gross_ev expression without this function following.
--
-- NOT CHANGED: fresh / r / agg / wins, the >= 10 gate, the calibration and winsorising branches, signature,
-- RETURNS, STABLE, SECURITY DEFINER, search_path, ACLs.
--
-- anon-exec: unchanged (get_pack_realized_ev_row) — CREATE OR REPLACE, same signature; ACL preserved (postgres + service_role); has_function_privilege anon=false, authenticated=false read 11-06.
--
-- REVERT: CREATE OR REPLACE get_pack_realized_ev_row from 20261025170047 (live prosrc md5 before this
-- migration: f50471b2ccf74ba6a965380b4f4cafbe).

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
    -- pack_ev_latest's FROM … WHERE, VERBATIM (20260905134612), plus this dist's
    -- index prefix. Pinned to the view by
    -- __tests__/pack-realized-ev-row-ev-leg-mirrors-pack-ev-latest.test.ts.
    SELECT
        CASE
            WHEN h.gross_ev = 0::numeric AND h.edition_count = 0 THEN NULL::numeric
            ELSE h.gross_ev
        END::numeric(10,2) AS gross_ev
    FROM pack_ev_history h
   LEFT JOIN pack_ask_state a
     ON a.collection_slug = 'nba-top-shot'::text
    AND a.dist_id = h.dist_id
    AND a.is_listed IS TRUE
    AND a.lowest_ask > 0::numeric
  WHERE h.pack_ev >= '-10000'::integer::numeric
    AND h.pack_ev <= 1000000::numeric
    AND h.pack_name !~~ 'Holding %'::text
    AND (h.pack_price > 0::numeric AND h.pack_price < 9999::numeric
         OR (h.pack_price IS NULL OR h.pack_price <= 0::numeric OR h.pack_price >= 9999::numeric)
            AND NOT (EXISTS ( SELECT 1
                   FROM pack_distributions pd
                  WHERE pd.dist_id = h.dist_id AND pd.collection_id = h.collection_id AND (pd.metadata ->> 'retail_price_usd'::text) IS NOT NULL)))
    AND NOT (h.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
             AND a.dist_id IS NOT NULL
             AND COALESCE(h.gross_ev > 3::numeric * a.lowest_ask, false))
      AND h.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND h.dist_id = p_dist_id
    ORDER BY h.snapshotted_at DESC, h.pack_listing_id
    LIMIT 1
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
