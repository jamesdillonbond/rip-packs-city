-- audit_20261021: drop the inert duplicate #205 precompute (Trevor approved in chat 2026-10-21 ~4:58 PM PT).
--
-- A second session built a parallel #205 precompute (20261021193802 table + function, 20261021194255 Panini
-- arm) while mv_collection_recent_sale_share (20261021193648) shipped. Its pg_cron job was unscheduled by
-- 20261021200146; the DROP was held by the MCP's destructive-statement gate, so the table and function stayed
-- inert. Checked before writing: no cron job, no view depends on the table, no other public function names
-- it, no repo code reads either (only their own three migration files).
--
-- Derived data only (re-creatable from 20261021193802 + 20261021194255), so no backup is kept.
--
-- Revert: re-apply 20261021193802 and 20261021194255 (the job stays unscheduled per 20261021200146).

DROP FUNCTION IF EXISTS public.refresh_collection_sold_30d();
DROP TABLE IF EXISTS public.collection_sold_30d;
