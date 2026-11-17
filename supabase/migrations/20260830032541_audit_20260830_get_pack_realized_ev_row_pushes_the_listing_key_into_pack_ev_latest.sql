-- audit_20260830_get_pack_realized_ev_row_pushes_the_listing_key_into_pack_ev_latest
--
-- WHY: get_pack_realized_ev_row(p_dist_id) — the pack page's realized-vs-modeled EV row — cost
-- 651,547 hit + 16,233 read buffers and 11.6 s for ONE dist (7672, 2,710 rips); pg_stat_statements
-- (PostgREST, since 08-12): 6,759 calls, 2.2 s mean, 101,801 buffers/call, max 30 s. The `ev` CTE
-- read `pack_ev_latest`, a DISTINCT ON (pack_listing_id) view over pack_ev_history, with a
-- predicate on dist_id/collection_id. Those are NOT the DISTINCT ON key, so the planner cannot
-- push them into the view: it materialised every listing's latest row for the whole table
-- (291,510 rows walked, 119,229 pack_ask_state probes for the troll-ask guard) and filtered
-- AFTERWARDS ("Rows Removed by Filter: 4615"). get_pack_market_row hit the same wall earlier
-- and switched to mv_pack_ev_latest (10-min stale, hand-copied guards); this keeps the VIEW —
-- the one source of truth for the publish guards — and makes its predicate pushable.
--
-- FIX: add `pel.pack_listing_id = ANY (ARRAY(SELECT DISTINCT pack_listing_id FROM pack_ev_history
-- WHERE collection_id = TS AND dist_id = p_dist_id))`. An InitPlan array on the DISTINCT ON key IS
-- pushable, so the view scans only that dist's listings via idx_pack_ev_history_listing_time.
-- Semantics are unchanged: the extra predicate is implied by the existing `pel.dist_id = p_dist_id
-- AND pel.collection_id = TS` (a listing's latest row for this dist has this dist_id). A new index
-- (collection_id, dist_id, snapshotted_at DESC) makes the InitPlan itself ~10 buffers instead of a
-- 7,075-buffer bitmap scan of every Top Shot row; pack_ev_history is 58 MB / 297k rows, so the
-- plain (non-CONCURRENT, migration-transaction) build takes ~1-2 s under a SHARE lock.
--
-- VERIFIED before apply (probe copy get_pack_realized_ev_row__probe, dropped): row_to_json equal on
-- 12 random dists with >= 10 opens (incl. two with NULL modeled EV), 7800 (22,189 rips), 7672,
-- a < 10-opens dist and a nonexistent dist (0 rows both). Generic-plan emulation of the ev leg:
-- 654,817 -> 8,475 buffers before the index (117 ms), ~1,400 expected with it.
-- anon-exec: intentional — same signature, ACLs unchanged by CREATE OR REPLACE; the public pack page reads it (get_pack_realized_ev_row).
--
-- REVERT: drop the `pel.pack_listing_id = ANY (...)` predicate (body otherwise identical to
-- the prior definition) and `DROP INDEX public.idx_pack_ev_history_collection_dist_time`.

CREATE INDEX IF NOT EXISTS idx_pack_ev_history_collection_dist_time
  ON public.pack_ev_history USING btree (collection_id, dist_id, snapshotted_at DESC);

CREATE OR REPLACE FUNCTION public.get_pack_realized_ev_row(p_dist_id text)
 RETURNS TABLE(modeled_gross_ev numeric, n_opens bigint, realized_mean numeric, realized_median numeric, realized_p90 numeric, realized_to_modeled_ratio numeric, calibrated_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT pr.pull_value_usd
    FROM topshot_pack_rip_attribution a
    JOIN pack_rips pr ON pr.id = a.rip_id
    WHERE a.dist_id = p_dist_id AND pr.pull_value_usd IS NOT NULL
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
