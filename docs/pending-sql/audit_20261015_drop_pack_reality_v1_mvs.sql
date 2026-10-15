-- audit_20261015_drop_pack_reality_v1_mvs
-- NOT APPLIED: a DROP is SQL-editor-only (the MCP write gate cancels it). Run from the SQL editor, then git mv into
-- supabase/migrations/ under the version the DB records.
-- WHY: 20261015015411 (2026-10-14) replaced the Pack Reality MVs with _v2 (value stats over PRICED rips only; v1 counted
--   7,012 unpriced rips as $0 pulls). The public views topshot_pack_reality_stats / _dist read _v2; pg_cron 240 / 237
--   refresh _v2. The two v1 MVs are no longer read or refreshed.
-- CHECKED 2026-10-15 ~6:35 AM PT: 64 kB each; 0 dependent views, 0 cron.job commands, 0 function bodies, 0 repo references.
-- No CASCADE on purpose: if anything has started depending on them since, the DROP fails instead of taking it along.
-- REVERT: re-create from the v1 definitions in the migration history (git log -S 'mv_topshot_pack_reality_stats');
--   nothing reads them, so a revert is only ever needed for archaeology.
DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_stats;
DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_dist;
