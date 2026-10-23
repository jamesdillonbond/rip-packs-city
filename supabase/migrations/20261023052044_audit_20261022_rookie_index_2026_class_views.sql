-- audit_20261022_rookie_index_2026_class_views
--
-- 2026-10-22 (PT, Claude Code cloud; Trevor: "Proceed with all, including rookie stuff").
--
-- WHAT. The public Rookie Index (/insights/rookies) only knew the 2025 class: it reads
-- topshot_2025_rookie_index + topshot_2025_rookie_cohort_stats, both over
-- topshot_2025_rookie_players (Series 8 rookie sets). The 2026 class started minting on
-- 2026-10-22 (Rookie Debut, set 281: Darryn Peterson, Cameron Boozer). These two views are
-- the 2026 siblings: the SAME bodies (live pg_get_viewdef of the 2025 pair, read 10:15 PM PT),
-- with the cohort read from topshot_2026_rookie_players (20261020225100: players with an
-- edition in the Series 9 Rookie Debut set). Nothing is seeded from the draft, so the class
-- grows by itself as Rookie Debut mints; the roadmap's 11-11 gate is about seeding, and
-- membership-from-minted-sets satisfies it.
--
-- Same shape, options and grants as the 2025 pair: security_invoker=on, anon/authenticated
-- SELECT (public player names and market aggregates only).
--
-- COST: the 2025 index reads ~13k buffers / 0.45 s over 61 players; the 2026 one starts at 2.
--
-- REVERT: DROP VIEW public.topshot_2026_rookie_cohort_stats; DROP VIEW public.topshot_2026_rookie_index;

CREATE VIEW public.topshot_2026_rookie_index WITH (security_invoker = on) AS
 WITH cohort AS (
         SELECT topshot_2026_rookie_players.player_name
           FROM topshot_2026_rookie_players
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
             LEFT JOIN sales ss ON ss.collection = 'nba_top_shot'::text AND ss.edition_id = pe.id AND ss.serial_number = 1 AND ss.price_usd > 0::numeric
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

COMMENT ON VIEW public.topshot_2026_rookie_index IS
  'Top Shot 2026 rookie class, per player: the topshot_2025_rookie_index body over topshot_2026_rookie_players. audit_20261022.';

CREATE VIEW public.topshot_2026_rookie_cohort_stats WITH (security_invoker = on) AS
 SELECT count(*) AS rookie_count,
    sum(sales_30d)::integer AS total_sales_30d,
    round(sum(gmv_30d), 0) AS total_gmv_30d,
    round(avg(NULLIF(avg_price_30d, 0::numeric)), 2) AS avg_price_active,
    count(*) FILTER (WHERE gmv_30d > 0::numeric) AS rookies_with_activity_30d,
    count(*) FILTER (WHERE max_mint_one_sale_usd > 0::numeric) AS rookies_with_mint_one_sale,
    max(max_mint_one_sale_usd) AS top_mint_one_sale,
    now() AS computed_at
   FROM topshot_2026_rookie_index;

COMMENT ON VIEW public.topshot_2026_rookie_cohort_stats IS
  'Top Shot 2026 rookie class header KPIs (one row): the topshot_2025_rookie_cohort_stats body over topshot_2026_rookie_index. audit_20261022.';

REVOKE ALL ON public.topshot_2026_rookie_index, public.topshot_2026_rookie_cohort_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.topshot_2026_rookie_index, public.topshot_2026_rookie_cohort_stats TO anon, authenticated, service_role;
