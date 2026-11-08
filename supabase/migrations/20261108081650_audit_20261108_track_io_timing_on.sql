-- audit_20261108_track_io_timing_on
-- Turns on track_io_timing for the two roles production reads run as (authenticator = PostgREST's
-- login role; postgres = pg_cron) so pg_stat_statements / auto_explain can split disk wait from
-- other time. ALTER DATABASE ... SET is refused (42501); per-role is what supautils allows.
-- No function, view or table is touched.
-- Revert: ALTER ROLE authenticator RESET track_io_timing; ALTER ROLE postgres RESET track_io_timing;
ALTER ROLE authenticator SET track_io_timing = on;
ALTER ROLE postgres SET track_io_timing = on;
