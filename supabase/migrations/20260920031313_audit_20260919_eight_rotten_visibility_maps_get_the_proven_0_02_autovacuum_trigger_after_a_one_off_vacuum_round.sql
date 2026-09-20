-- The R109 line closed tonight on "THE VISIBILITY MAP WAS THE MECHANISM" (dated falsifier,
-- 2026-09-19 6:40 PM PT: wmc/atlas heap fetches 117,758 → 15,238 at steady state under the
-- 0.02 scale factors). That lever was applied to three tables. A sweep of every public table
-- over 5,000 pages with < 90 % of pages all-visible (8:00 PM PT, quiet box) found eight more,
-- several of them read paths users wait on:
--
--   table                        pages    all-visible   dead      last autovacuum
--   pack_rips                    97,540   66.7 %        127,651   09-12 (count 2)
--   sales_2023                   39,006   89.5 %        20,117    09-08 (count 1)
--   allday_pack_sales_history    18,109    0.0 %        92,425    09-12
--   topshot_pack_sales_history   21,521    8.3 %        48,491    09-19 (count 58 — churn)
--   moments                      17,065   59.9 %        20,136    09-14
--   panini_card_serials          21,765   46.2 %        10,839    09-19
--   topshot_moment_subeditions    8,040   67.6 %        190,026   09-04
--   offers                        6,368   10.0 %        31,338    09-02
--   (and sales_2025: 59.7 %, never autovacuumed since the stats reset — vacuumed 7:57 PM PT, 12 s → 100 %)
--
-- The default 0.2 scale factor on a million-row table is a 200k-dead-tuple threshold that a
-- read-mostly table never reaches, so its map rots under the trickle of updates it does get
-- and every Index Only Scan on it pays heap fetches (the R109 tell). One-off manual
-- VACUUM (ANALYZE) as postgres via pg_cron, one per minute, 8:00–8:11 PM PT:
--   allday_pack_sales_history 8.3 s → 100 % · topshot_pack_sales_history 8.0 s → 99.3 % ·
--   offers 2.1 s → 100 % · topshot_moment_subeditions 4.4 s → 100 % · moments 6.7 s → 100 % ·
--   panini_card_serials 4.7 s → 100 %.
--   ⛔ sales_2023 and pack_rips DIED at the 120 s cluster default "while scanning relation"
--   (pack_rips at block 41,556 of 97,540 — the manual scan moved ~2.7 MB/s). A manual VACUUM of
--   a 300–800 MB table is unreachable here (memory: vacuum-is-unreachable-on-this-instance);
--   autovacuum is not subject to statement_timeout, so the durable lever for those two is the
--   threshold, and it fires on the next naptime cycle: pack_rips 128k dead > 0.02 × 3.69 M =
--   73.8 k; sales_2023 20.1 k dead > 0.01 × 1.25 M = 12.5 k (0.01 because it is a cold
--   partition whose only writes are corrections).
--
-- Per-table settings only (no rewrite, no lock beyond a brief ACCESS EXCLUSIVE for the catalog
-- update). Same shape as wallet_moments_cache / topshot_atlas_market_events / fmv_snapshots_2026.
-- Applied from Cowork cloud 2026-09-19 8:14 PM PT. ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: by 09-20 morning PT, pg_stat_all_tables.autovacuum_count has advanced on pack_rips and
-- sales_2023 and pg_class.relallvisible/relpages reads > 95 % on both; the six vacuumed tables
-- hold > 95 % a day later with autovacuum_count climbing.
-- FALSIFIER: a map that reads < 90 % a day later WITH autovacuum_count still climbing ⇒ the
-- rot is UPDATE-in-place churn under long-open snapshots (the wmc hypothesis), and the
-- threshold cannot fix it — measure, do not lower further.
-- REVERT: ALTER TABLE <t> RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor,
--         autovacuum_vacuum_insert_scale_factor); (moments/pack_rips/sales_2023 go back to
--         SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)).

ALTER TABLE public.pack_rips                  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05);
ALTER TABLE public.sales_2023                 SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.allday_pack_sales_history  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05);
ALTER TABLE public.topshot_pack_sales_history SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.05);
ALTER TABLE public.moments                    SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.panini_card_serials        SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.topshot_moment_subeditions SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.offers                     SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.relname IN ('pack_rips','sales_2023','allday_pack_sales_history','topshot_pack_sales_history',
                       'moments','panini_card_serials','topshot_moment_subeditions','offers')
     AND c.relnamespace = 'public'::regnamespace
     AND EXISTS (SELECT 1 FROM unnest(c.reloptions) o WHERE o LIKE 'autovacuum_vacuum_scale_factor=0.0%');
  IF v_n <> 8 THEN RAISE EXCEPTION 'expected 8 tables with the trigger set, got %', v_n; END IF;
END $$;
