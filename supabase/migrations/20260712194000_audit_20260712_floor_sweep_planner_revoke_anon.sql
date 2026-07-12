-- Security fix: the three functions added today (detect_topshot_sweeps,
-- get_edition_sweep_signal, get_topshot_set_completion_plan) picked up explicit
-- anon + authenticated EXECUTE grants from the project's ALTER DEFAULT PRIVILEGES
-- on new public functions. The migrations only did REVOKE ... FROM PUBLIC, which
-- does not remove the explicit role grants, so all three ended up anon-executable
-- (flagged by the anon/authenticated_security_definer_function_executable advisors).
--
-- These are SECDEF and service_role-only by intent (matching detect_concentration_buys /
-- get_edition_recent_sales) — and detect_topshot_sweeps WRITES to topshot_insider_alerts,
-- so anon executability is a real abuse vector. Revoke from anon + authenticated + PUBLIC;
-- keep service_role (+ owner postgres). They are called only from server routes / the
-- insider-detector cron via the service-role client.
--
-- Revert: GRANT EXECUTE ON FUNCTION ... TO anon, authenticated (not advised).

REVOKE EXECUTE ON FUNCTION public.detect_topshot_sweeps(text,integer,integer,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_edition_sweep_signal(uuid,integer,integer,integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_topshot_set_completion_plan(text,uuid,integer) FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.detect_topshot_sweeps(text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_edition_sweep_signal(uuid,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_topshot_set_completion_plan(text,uuid,integer) TO service_role;
