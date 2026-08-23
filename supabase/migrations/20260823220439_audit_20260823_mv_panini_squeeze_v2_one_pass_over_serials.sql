-- ⭐ mv_panini_squeeze rebuilt: THREE correlated subqueries over panini_card_serials
-- collapse into ONE grouped pass. Non-destructive step 1 of 2 — this creates the
-- replacement only; panini_squeeze_board still reads the OLD mv until the cutover.
--
-- WHY (measured 2026-08-23 ~22:00Z, and the ledger asked for exactly this re-derive:
-- "⚠ Sample is small (1–3 refreshes each) … re-derive after a day before quoting these"):
--
--   jobid 353 rpc-refresh-panini-squeeze, last 24h: 48 runs, 9 FAILED (18.75%),
--   avg 271.7 s, max 618 s, 13,040 worker-seconds/day — the 2nd largest cron
--   consumer on the instance — to rebuild a materialized view of
--   4,684 rows / 2,184 kB.
--
-- THE PLAN SHOWS ONE CULPRIT, not the FMV lateral I first assumed:
--   SubPlan 2  is_rookie  ->  Seq Scan on panini_card_serials  (cost 18,755) x4,684 rows
--   SubPlan 3  is_debut   ->  Index Scan (cost 25)             x4,684
--   SubPlan 5  count(*)   ->  Index Scan (cost 25)             x4,684
--   FMV lateral           ->  Index Scan (cost 1.69)           x4,684   <- already cheap
-- `nft_type LIKE '%rookie card%'` is a LEADING-WILDCARD predicate no btree can serve,
-- and the planner estimates 21,212 matches, so it abandons idx_panini_serials_edition
-- and SEQ SCANS the whole 88,086-row table once PER EDITION. is_debut estimates 10
-- matches and keeps the index — same shape, opposite plan, purely estimate-driven.
--
-- MEASURED, new body, EXPLAIN (ANALYZE, BUFFERS):
--   Execution Time 1,402 ms · shared hit=21,775 read=17,993
--   panini_card_serials is now ONE Seq Scan (88,086 rows) -> HashAggregate.
--   vs the current refresh: 234,158 ms mean (pipeline_runs) and 56,789 blocks/call
--   (pg_stat_statements). Reads 56,789 -> 17,993 per refresh.
-- ⚠ ONE run, in the quietest hour on the board (2 active clients, 1 IO wait). It is
-- NOT a warm-cache artifact — read=17,993 is real disk — but expect it slower under
-- load. The structural claim is the read count and the 4,684 -> 1 seq scans, not the ms.
--
-- EQUIVALENCE PROVEN before writing this, against the live MV, all 4,684 rows:
--   diff_rookie 0 · diff_debut 0 · diff_serials_with_recorded_price 3
-- All THREE count diffs are ingest drift, not semantics: each has a panini_card_serials
-- captured_at strictly AFTER the 21:48:00Z refresh that built the MV (21:48:19, 21:57:00,
-- 22:00:00) and each delta is positive. panini-ingest runs 840x/day, so drift in a
-- 13-minute comparison window is expected.
--
-- SEMANTICS, exactly preserved:
--   EXISTS(...)  -> COALESCE(bool_or(...), false)   -- bool_or is NULL on no rows; EXISTS
--                                                      is false. COALESCE reconciles.
--   (SELECT count(*) ...) -> COALESCE(count(*) FILTER (...), 0)  -- count over an empty
--                                                      set is 0; the LEFT JOIN gives NULL.
--   NULL nft_type: `NULL LIKE '%x%'` is NULL; bool_or skips NULLs, EXISTS yields no row.
--   Same column list, same order, same types (count -> bigint preserved).
--
-- REVERT: DROP MATERIALIZED VIEW public.mv_panini_squeeze_v2;
CREATE MATERIALIZED VIEW public.mv_panini_squeeze_v2 AS
WITH serial_agg AS (
  SELECT cs.edition_external_id,
         COALESCE(bool_or(cs.nft_type LIKE '%rookie card%'), false) AS is_rookie,
         COALESCE(bool_or(cs.nft_type LIKE '%debut card%'),  false) AS is_debut,
         count(*) FILTER (WHERE cs.last_sale_usd IS NOT NULL)       AS serials_with_recorded_price
  FROM panini_card_serials cs
  GROUP BY cs.edition_external_id
)
SELECT e.id,
    e.external_id,
    e.collection_id,
    e.player_name,
    e.nation,
    e.set_name,
    e.parallel,
    e.parallel_family,
    e.rarity_label,
    e.tier,
    e.mint_cap,
    e.pulled_count,
    e.still_in_packs,
        CASE
            WHEN COALESCE(e.mint_cap, 0) > 0 THEN round(e.pulled_count::numeric / e.mint_cap::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS rip_pct,
    e.is_fotl_exclusive,
    COALESCE(sa.is_rookie, false) AS is_rookie,
    COALESCE(sa.is_debut,  false) AS is_debut,
    f.fmv_usd,
    round(e.still_in_packs::numeric * f.fmv_usd) AS sealed_fmv_exposure_usd,
    f.confidence AS fmv_confidence,
    e.serial_low_ask_usd,
    e.thumbnail_url,
    COALESCE(sa.serials_with_recorded_price, 0::bigint) AS serials_with_recorded_price,
    ca.coverage_flag
   FROM panini_editions e
     LEFT JOIN serial_agg sa ON sa.edition_external_id = e.external_id
     LEFT JOIN LATERAL ( SELECT s.fmv_usd,
            s.confidence
           FROM panini_fmv_snapshots s
          WHERE s.edition_id = e.id
          ORDER BY s.computed_at DESC
         LIMIT 1) f ON true
     LEFT JOIN panini_coverage_audit ca ON ca.set_name = e.set_name AND NOT ca.parallel_family IS DISTINCT FROM e.parallel_family
  WHERE e.mint_cap IS NOT NULL;

-- REFRESH ... CONCURRENTLY requires a unique index; mirrors mv_panini_squeeze_key.
CREATE UNIQUE INDEX mv_panini_squeeze_v2_key
  ON public.mv_panini_squeeze_v2 USING btree (player_name, set_name, tier);

-- Mirror the old MV's ACL exactly: postgres + service_role only, NO anon/authenticated.
-- panini_squeeze_board is security_invoker=on, so its callers need rights here; the
-- board is read server-side as service_role, never by anon.
GRANT ALL ON TABLE public.mv_panini_squeeze_v2 TO service_role;