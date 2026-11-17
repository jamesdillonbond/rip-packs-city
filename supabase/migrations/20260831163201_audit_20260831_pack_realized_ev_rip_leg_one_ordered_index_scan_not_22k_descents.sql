-- audit_20260831_pack_realized_ev_rip_leg_one_ordered_index_scan_not_22k_descents
--
-- WHY: 20260830032541 fixed the `ev` CTE of get_pack_realized_ev_row (the pack page's
-- realized-vs-modeled EV row) and left the `r` CTE as the dominant cost. Measured today
-- (2026-08-31, DB now() 16:2xZ), EXPLAIN (ANALYZE, BUFFERS) through the function for
-- dist 7800: 92,544 buffers / 621 ms total, of which the `ev` leg is now only 1,507 and
-- the `r` leg is 89,190. `r` joins topshot_pack_rip_attribution -> pack_rips on the PK
-- and the planner picks a Nested Loop: 22,192 INDEPENDENT pack_rips_pkey descents at
-- ~4 buffers each (3 index + 1 heap) against a 756 MB / 3.68 M-row table.
--
-- The row estimate is also wrong in a way that keeps it there: pg_stats says
-- pack_rips.pull_value_usd is 91.3% NULL, so the join is costed at 1,924 rows when it
-- actually returns 22,192 -- but a Hash Join is NOT the answer either (a pack_rips seq
-- scan is ~96,700 pages, worse than the 89,190 it replaces). Checked before assuming.
--
-- FIX: same technique 20260830032541 used one leg over -- collect the rip ids in an
-- InitPlan array so the pack_rips access becomes ONE ordered index scan over a sorted
-- id list instead of 22,192 separate descents.
--
-- MEASURED A/B, same warm state, back to back, on TOTAL BUFFERS TOUCHED (a plan change
-- cannot be faked by a warm cache, a wall-clock ratio can), dist 7800:
--     baseline  (JOIN, Nested Loop) : 89,190 buffers / 154.7 ms
--     candidate (= ANY(ARRAY(...))) : 50,573 buffers / 125.1 ms
--   -> 1.76x fewer buffers touched. The baseline was RE-RUN AFTER the candidate in the
--      same cache state; the first (cold) candidate reading, 50,699 buffers, agrees.
--
-- EQUIVALENCE PROVEN, NOT ASSERTED. The two shapes differ only if a rip_id can appear
-- twice for one dist (the JOIN would count it twice, `= ANY` once). Measured live over
-- all 37,556 attribution rows: 37,556 distinct (dist_id, rip_id) pairs, 0 duplicate
-- pairs, 0 rip_ids in more than one dist. And over ALL 340 dists, (count, sum, min, max)
-- of the surviving pull_value_usd is symmetric-difference 0 in BOTH directions.
--
-- NOT CHANGED, on purpose: agg / wins / ev, the >= 10 n_opens gate, the winsorising
-- branch, the signature, RETURNS columns, STABLE, SECURITY DEFINER, search_path and the
-- ACLs. Only the `r` CTE's access path moves, so the win is attributable on its own.
--
-- anon-exec: intentional -- same signature, ACLs unchanged by CREATE OR REPLACE; the public pack page reads it (get_pack_realized_ev_row).
--
-- REVERT: CREATE OR REPLACE the function with the `r` CTE restored to
--   SELECT pr.pull_value_usd FROM topshot_pack_rip_attribution a
--   JOIN pack_rips pr ON pr.id = a.rip_id
--   WHERE a.dist_id = p_dist_id AND pr.pull_value_usd IS NOT NULL
-- Nothing else differs. No index is created or dropped by this migration.
--
-- EXIT CONDITION (from the post-fix measurement taken here, not a hoped-for order of
-- magnitude): the `r` leg for dist 7800 stays at or below ~51,000 buffers touched, and
-- the pgss diff mean for get_pack_realized_ev_row stays at or below its pre-ship
-- 804 ms / call (10 calls, 15:12->16:22Z window). FALSIFIER: if the pgss mean does NOT
-- fall, the remaining cost is service time, not work -- the same cheap-in-work /
-- slow-in-wall shape the 15:15Z filing recorded for this function and for
-- get_acquisition_stats -- and the next lever is NOT more SQL.

CREATE OR REPLACE FUNCTION public.get_pack_realized_ev_row(p_dist_id text)
 RETURNS TABLE(modeled_gross_ev numeric, n_opens bigint, realized_mean numeric, realized_median numeric, realized_p90 numeric, realized_to_modeled_ratio numeric, calibrated_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (
    SELECT pr.pull_value_usd
    FROM pack_rips pr
    WHERE pr.id = ANY (ARRAY(
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