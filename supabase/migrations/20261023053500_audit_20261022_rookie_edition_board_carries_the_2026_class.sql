-- audit_20261022_rookie_edition_board_carries_the_2026_class
--
-- 2026-10-22 (PT, Claude Code cloud; Trevor: "Proceed with all, including rookie stuff").
--
-- WHAT. topshot_rookie_edition_board (the /insights/rookie-board per-parallel view) joined
-- topshot_2025_rookie_players only. It now joins both classes and gains a LAST column,
-- `rookie_class` ('2025' | '2026'), so the board can tab between them. The 2026 class is
-- topshot_2026_rookie_players (Series 9 Rookie Debut membership — fills as that set mints);
-- names already in the 2025 class are excluded from the 2026 arm so an edition can never
-- appear twice (0 overlap at apply). Every other column is byte-for-byte the live body
-- (pg_get_viewdef read 10:33 PM PT).
--
-- ⚠ CREATE OR REPLACE VIEW RESETS reloptions — security_invoker=on is restated here, and a
-- new column may only be appended (42P16 otherwise). No dependent objects (pg_depend 0).
-- Read at apply: 551 rows (2025 class); the 2026 arm adds the Rookie Debut rows.
--
-- REVERT: CREATE OR REPLACE cannot DROP a column — DROP VIEW and re-create from the
-- previous body (join topshot_2025_rookie_players rp, no rookie_class), WITH
-- (security_invoker = on), GRANT SELECT TO anon, authenticated, service_role.

CREATE OR REPLACE VIEW public.topshot_rookie_edition_board WITH (security_invoker = on) AS
 SELECT e.player_name,
    e.set_name,
    e.series AS series_number,
    e.tier::text AS tier,
    COALESCE(e.subedition_id::integer, 0) AS parallel_id,
    COALESCE(e.subedition_name, 'Standard'::text) AS parallel_name,
    e.external_id,
    e.circulation_count,
    fs.fmv_usd,
    fs.confidence AS fmv_confidence,
    be.low_ask,
    be.highest_offer,
    be.avg_sale_price,
    be.burned,
    be.locked,
    be.effective_supply,
    be.burn_rate_pct,
    be.lock_rate_pct,
    be.external_id IS NOT NULL AS has_full_economics,
    e.thumbnail_url,
    e.video_url,
    rp.rookie_class
   FROM editions e
     JOIN ( SELECT p25.player_name, '2025'::text AS rookie_class
              FROM topshot_2025_rookie_players p25
            UNION ALL
            SELECT p26.player_name, '2026'::text AS rookie_class
              FROM topshot_2026_rookie_players p26
             WHERE NOT (p26.player_name IN ( SELECT topshot_2025_rookie_players.player_name
                       FROM topshot_2025_rookie_players))) rp ON rp.player_name = e.player_name
     LEFT JOIN badge_editions be ON be.external_id = e.external_id::text AND be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     LEFT JOIN LATERAL ( SELECT fmv_snapshots.fmv_usd,
            fmv_snapshots.confidence
           FROM fmv_snapshots
          WHERE fmv_snapshots.edition_id = e.id
          ORDER BY fmv_snapshots.computed_at DESC
         LIMIT 1) fs ON true
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND e.external_id::text ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'::text;

COMMENT ON VIEW public.topshot_rookie_edition_board IS
  'One row per Top Shot rookie edition (set x parallel) for the 2025 and 2026 classes; rookie_class names the class. audit_20261022.';

GRANT SELECT ON public.topshot_rookie_edition_board TO anon, authenticated, service_role;
