-- audit_20260822_least_privilege_cron_and_net_tables
--
-- COMMITTED UNAPPLIED. Trevor's call when to run it.
--
-- The pg_cron and pg_net extension tables were created with broad PUBLIC grants:
--   cron.job                 PUBLIC: SELECT
--   cron.job_run_details     PUBLIC: SELECT, DELETE
--   net.http_request_queue   PUBLIC: ALL
--   net._http_response       PUBLIC: ALL
-- Nothing in this repo granted these; they are extension/default-privilege
-- inheritance. Reducing them to least privilege is ordinary hardening: a pg_cron
-- command string can carry credentials, and a queue row can carry a request URL,
-- so neither belongs under a blanket PUBLIC grant.
--
-- ⚠ THE TRAP THIS MIGRATION EXISTS TO AVOID. anon/authenticated hold nothing of
-- their own here -- their access is entirely PUBLIC-derived. So is postgres's on
-- the two net tables. A bare "REVOKE ... FROM PUBLIC" therefore ALSO strips
-- postgres, and five SECURITY DEFINER functions in public are owned by postgres
-- and read these tables:
--   check_edge_fn_http_failures      -> net._http_response
--   resolve_topshot_username_live    -> net._http_response (+ calls net.http_get)
--   check_pgcron_recent_failures     -> cron.job / job_run_details
--   get_pipeline_alerts_core         -> cron.job
--   board_mv_refresh_max_stale_hours -> cron.job
-- Two of those are trust-board checks, so a naive revoke takes monitoring dark
-- while reporting success. The explicit GRANTs below are load-bearing, not tidy-up.
--
-- ✅ CHECKED, so pg_net itself is NOT affected: net.http_get and net.http_post are
-- SECURITY DEFINER owned by supabase_admin, which holds explicit full grants. The
-- queue INSERT on every cron tick runs as supabase_admin and does not consult
-- PUBLIC. (net.http_delete is INVOKER -- it is not used by any cron job here.)
--
-- ⚠ service_role is deliberately NOT re-granted. Its access today is also
-- PUBLIC-derived, but no application code reads these tables (repo grep: 4 hits,
-- all comments) and every server-side reader goes through the definer functions
-- above, which run as postgres. If something does turn out to need it, grant it
-- explicitly rather than restoring the PUBLIC grant.

REVOKE ALL ON TABLE cron.job                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE cron.job_run_details    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE net.http_request_queue  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE net._http_response      FROM PUBLIC, anon, authenticated;

-- postgres already holds explicit grants on both cron tables (r* / full), so it
-- needs nothing there. It holds NOTHING explicit on the net tables -- these two
-- statements are what keep check_edge_fn_http_failures and
-- resolve_topshot_username_live working after the revoke.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE net.http_request_queue TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE net._http_response     TO postgres;

-- ============================================================================
-- VERIFY AFTER APPLYING -- read privileges, never the acl text (CLAUDE.md).
-- Expect anon/authenticated false on every row, postgres true on every row.
-- ============================================================================
-- SELECT c.oid::regclass::text AS tbl,
--        has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,
--        has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
--        has_table_privilege('postgres',      c.oid, 'SELECT') AS pg_select,
--        has_table_privilege('postgres',      c.oid, 'INSERT') AS pg_insert
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE (n.nspname='cron' AND c.relname IN ('job','job_run_details'))
--     OR (n.nspname='net'  AND c.relname IN ('http_request_queue','_http_response'));
--
-- POSITIVE CONTROL -- prove the definer functions still work, because a
-- privilege table that looks right is not the same as monitoring that runs:
-- SELECT public.check_edge_fn_http_failures();
-- SELECT public.check_pgcron_recent_failures();

-- ============================================================================
-- REVERT -- uncomment this entire block and apply it to restore the prior grants.
-- Captured from pg_class.relacl 2026-08-22, before the change.
-- ============================================================================
-- GRANT SELECT                       ON TABLE cron.job               TO PUBLIC;
-- GRANT SELECT, DELETE               ON TABLE cron.job_run_details   TO PUBLIC;
-- GRANT ALL                          ON TABLE net.http_request_queue TO PUBLIC;
-- GRANT ALL                          ON TABLE net._http_response     TO PUBLIC;
