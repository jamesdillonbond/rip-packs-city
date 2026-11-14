-- audit_20261113_pg_net_request_log_prune — 2026-11-13 ~7:25 PM PT (Claude Code cloud; #241 follow-up).
-- Keeps public.pg_net_request_log (filled by the pg_net_request_log_capture trigger, ~44k rows/day) to 24 h:
-- check_edge_fn_http_failures only joins it inside its window (<= 12 h). Hourly at :41.
-- Revert: SELECT cron.unschedule('rpc-pg-net-request-log-prune');
select cron.schedule('rpc-pg-net-request-log-prune', '41 * * * *',
                     $$DELETE FROM public.pg_net_request_log WHERE dispatched_at < now() - interval '24 hours'$$);