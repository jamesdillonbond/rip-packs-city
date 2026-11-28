-- audit_20261127_drop_unused_purge_fmv_snapshots_today_except
--
-- 2026-11-27 ~4:00 PM PT (Cowork cloud; Trevor: "You do it", answering "the old 3-argument purge function is unused
-- now — drop it whenever you like").
--
-- WHAT. purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]) (20261023151316) was replaced at 3:20 PM PT by
-- purge_fmv_snapshots_today_except_before (20261127231105), which also spares rows a concurrent fmv-recalc run wrote
-- after this run started. Callers checked before the drop: app/api/fmv-recalc/route.ts calls only the _before
-- sibling (deployed 7f6a2ee, 3:20 PM PT); 0 pg_cron commands and 0 SQL functions name the old one; no other code
-- path in app/, lib/, scripts/ or supabase/functions/ does. Its pin and drift-guard entry are removed in the same
-- commit, so db-pin-staleness does not look for it.
-- The sibling purge_fmv_snapshots_today (no keep-list) is a different function and is untouched.
--
-- REVERT: re-apply supabase/migrations/20261023151316_audit_20261023_fmv_recalc_replace_delete_keeps_what_it_did_not_write.sql
--         (function, revokes, service_role grant), and restore its pin + drift-guard entry from git.

DROP FUNCTION IF EXISTS public.purge_fmv_snapshots_today_except(uuid[], timestamptz, uuid[]);
