-- audit_20260811_precompute_split_m3b_grant_cron_heavy_exec
--
-- HOTFIX for the precompute split: job 287 runs as cron_heavy (its owner), but
-- the M1/M2 procedure + leg functions were revoked to postgres+service_role
-- only, so the 00:58Z first tick failed "permission denied for procedure
-- rpc_trust_health_precompute_refresh_p". The retired monolith carried an
-- explicit cron_heavy=X grant (that is why it ran for months); this restores
-- the same grant on the new objects.
--
-- The INVOKER orchestrator runs as cron_heavy and PERFORMs each SECDEF leg, so
-- cron_heavy needs EXECUTE on the procedure AND all 7 leg functions (EXECUTE
-- privilege is required to CALL a function even when it is SECURITY DEFINER).
-- anon/authenticated stay revoked — cron_heavy is an internal pg_cron role, not
-- a client role, so this does not widen the anon surface.
--
-- Revert: REVOKE EXECUTE ... FROM cron_heavy on the 8 objects.

GRANT EXECUTE ON PROCEDURE public.rpc_trust_health_precompute_refresh_p() TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_panini()              TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_pack_ev()             TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_fmv_sanity()          TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_serial_supply()       TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_fmv_coverage()        TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_board_liveness()      TO cron_heavy;
GRANT EXECUTE ON FUNCTION public.rpc_thp_leg_impossible_parallel() TO cron_heavy;
