-- audit_20260906_rookie_index_mint_one_join_scoped_to_the_collection
--
-- Trust Health `public_board_slow_count = 1` on the 09-06 sentinel: the slow
-- board was `topshot_2025_rookie_cohort_stats` (4,916 ms against a 3,000 ms
-- budget), a one-row aggregate over `topshot_2025_rookie_index`. History shows
-- the regression is not a spike: ~1 s through 09-03, 3.4–8.8 s on every sweep
-- since 09-04 (five straight breaches).
--
-- The cost, by BUFFERS not timings: the `mint_one` CTE joins `sales` on
-- `edition_id = pe.id AND serial_number = 1` with NO collection predicate. The
-- only serial-1 index is `idx_sales_*_serial1 (collection, edition_id, sold_at)
-- WHERE serial_number = 1`, whose LEADING column is `collection` — so the
-- planner walked the ENTIRE partial index on every partition (7,644 rows,
-- 6,128 cold heap reads, 3.9 s of random IO) and hash-joined to the 685
-- cohort editions. With `ss.collection = 'nba_top_shot'` in the join the same
-- index answers 685 point probes per partition: 0 reads, 14 ms.
--
-- EQUIVALENCE, PROVEN OVER THE POPULATION (CLAUDE.md: scoping an aggregate is
-- an equivalence claim): every serial-1, price>0 sale whose edition is in the
-- Top Shot collection carries collection = 'nba_top_shot' — 6,379 of 6,379
-- (measured 2026-09-06 21:40Z). The join is a restriction to rows that already
-- qualify; the view's output is unchanged.
--
-- `WITH (security_invoker = on)` is restated because CREATE OR REPLACE VIEW
-- with no WITH clause RESETS reloptions (four prior occurrences). Column list
-- and order are byte-identical (42P16 otherwise). Grants survive a REPLACE.
--
-- Revert: re-create the view from `pg_get_viewdef` at 20260906 without the
-- `ss.collection = 'nba_top_shot'` predicate (or `git show` this file's parent).

CREATE OR REPLACE VIEW public.topshot_2025_rookie_index
WITH (security_invoker = on) AS
 WITH cohort AS (
         SELECT topshot_2025_rookie_players.player_name
           FROM topshot_2025_rookie_players
        ), player_editions AS (
         SELECT e.id,
            e.external_id,
            e.player_name,
            e.tier
           FROM editions e
             JOIN cohort c_1 ON c_1.player_name = e.player_name
          WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
        ), sales_30d AS (
         SELECT pe.player_name,
            count(s_1.id) AS sales_30d,
            sum(s_1.price_usd) AS gmv_30d,
            avg(s_1.price_usd) AS avg_price_30d,
            max(s_1.price_usd) AS max_sale_30d
           FROM player_editions pe
             LEFT JOIN sales s_1 ON s_1.edition_id = pe.id AND s_1.sold_at >= (now() - '30 days'::interval) AND s_1.price_usd > 0::numeric
          GROUP BY pe.player_name
        ), badge_agg AS (
         SELECT pe.player_name,
            sum(COALESCE(be.locked, 0))::integer AS total_locked,
            sum(COALESCE(be.burned, 0))::integer AS total_burned,
            sum(COALESCE(be.circulation_count, 0))::integer AS total_circ,
            avg(be.lock_rate_pct) AS avg_lock_rate_pct
           FROM player_editions pe
             LEFT JOIN badge_editions be ON be.external_id = pe.external_id::text AND be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
          GROUP BY pe.player_name
        ), mint_one AS (
         SELECT pe.player_name,
            count(DISTINCT pe.id) FILTER (WHERE ss.id IS NOT NULL) AS mint_one_eds_with_history,
            max(ss.price_usd) AS max_mint_one_sale
           FROM player_editions pe
             -- 2026-09-06: `ss.collection = 'nba_top_shot'` makes idx_sales_*_serial1 (collection, edition_id, …)
             -- a point probe instead of a full partial-index walk. Proven equivalent over the population.
             LEFT JOIN sales ss ON ss.collection = 'nba_top_shot' AND ss.edition_id = pe.id AND ss.serial_number = 1 AND ss.price_usd > 0::numeric
          GROUP BY pe.player_name
        ), ed_counts AS (
         SELECT player_editions.player_name,
            count(*)::integer AS edition_count
           FROM player_editions
          GROUP BY player_editions.player_name
        )
 SELECT c.player_name,
    ec.edition_count,
    COALESCE(s.sales_30d, 0::bigint)::integer AS sales_30d,
    round(COALESCE(s.gmv_30d, 0::numeric), 2) AS gmv_30d,
    round(COALESCE(s.avg_price_30d, 0::numeric), 2) AS avg_price_30d,
    round(COALESCE(s.max_sale_30d, 0::numeric), 2) AS max_sale_30d,
    ba.total_locked,
    ba.total_burned,
    ba.total_circ,
    round(100.0 * (COALESCE(ba.total_locked, 0) + COALESCE(ba.total_burned, 0))::numeric / NULLIF(ba.total_circ, 0)::numeric, 1) AS cohort_squeeze_pct,
    round(ba.avg_lock_rate_pct, 1) AS avg_lock_rate_pct,
    COALESCE(mo.mint_one_eds_with_history, 0::bigint) AS mint_one_eds_with_history,
    round(mo.max_mint_one_sale, 2) AS max_mint_one_sale_usd
   FROM cohort c
     LEFT JOIN ed_counts ec ON ec.player_name = c.player_name
     LEFT JOIN sales_30d s ON s.player_name = c.player_name
     LEFT JOIN badge_agg ba ON ba.player_name = c.player_name
     LEFT JOIN mint_one mo ON mo.player_name = c.player_name;

ALTER VIEW public.topshot_2025_rookie_index SET (security_invoker = on);
