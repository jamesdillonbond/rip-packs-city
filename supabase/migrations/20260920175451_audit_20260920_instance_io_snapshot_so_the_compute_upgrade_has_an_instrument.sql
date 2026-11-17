-- audit_20260920_instance_io_snapshot_so_the_compute_upgrade_has_an_instrument
-- anon-exec: ops_db_io_snapshot — NEW function; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- WHY. Compute moved Small -> Large at 2026-09-20 10:39 AM PT on a measured argument: 20.4 MB/s
-- sustained disk read and 2,607 read IOPS against Small's published 22 MB/s / 1,000 baseline, with
-- io_wait 16 of 16 active backends. That decision now owes a dated verdict, and the estate has no
-- instrument that can give one.
--
-- WHAT IS ALREADY THERE, AND WHY THIS IS NOT A DUPLICATE. public.ops_pgss_snapshot(4) +
-- ops_pgss_delta() (migration 20260901035254, cron rpc-pgss-snapshot '5 */2 * * *') cover
-- pg_stat_statements — per-QUERY disk reads. They cannot answer "what is the INSTANCE reading per
-- second", which is the quantity the tier caps and the quantity the upgrade bought. The 2026-09-19
-- ledger recorded the gap in its own words while trying to attribute a 3-minute spell:
-- "Unattributed (possibly my EXPLAIN probes — no IO-history table exists to check)."
--
-- ⚠ THE TRAP THIS INSTRUMENT IS SHAPED AROUND. pg_stat_database is TRANSACTION-STABLE: a single
-- statement that reads it twice returns the SAME row both times. The first attempt at the
-- pre-upgrade measurement reported 0 blks_read over 20 s during a live spell with io_wait 14. A
-- rate therefore CANNOT be computed inside one call — it must come from two rows taken by two
-- separate transactions, which is exactly what a scheduled snapshot gives you.
--
-- COST. One row/hour, ~15 columns, no scans of user tables. At 90 days that is ~2,160 rows.
-- Deliberately hourly rather than 2-hourly: the first days after a tier change are the window
-- where resolution matters, and the prune keeps it bounded regardless.

CREATE TABLE IF NOT EXISTS public.audit_20260920_ops_db_io_snap (
  captured_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  blks_read          bigint      NOT NULL,
  blks_hit           bigint      NOT NULL,
  xact_commit        bigint      NOT NULL,
  xact_rollback      bigint      NOT NULL,
  temp_files         bigint      NOT NULL,
  temp_bytes         bigint      NOT NULL,
  deadlocks          bigint      NOT NULL,
  backends           integer     NOT NULL,
  io_wait_backends   integer     NOT NULL,
  active_backends    integer     NOT NULL,
  postmaster_start   timestamptz NOT NULL,
  shared_buffers_mb  integer     NOT NULL,
  work_mem_kb        integer     NOT NULL,
  note               text,
  PRIMARY KEY (captured_at)
);

ALTER TABLE public.audit_20260920_ops_db_io_snap ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260920_ops_db_io_snap FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.audit_20260920_ops_db_io_snap TO postgres, service_role;

COMMENT ON TABLE public.audit_20260920_ops_db_io_snap IS
'Instance-level IO counters, one row/hour via cron rpc-db-io-snapshot. NOT disposable despite the audit_ name: it is the only instrument that can rate-check disk throughput against the compute tier''s published baseline (Small 22 MB/s / 1,000 IOPS; Large 79 / 3,600). A RATE needs two rows from two separate transactions - pg_stat_database is transaction-stable and returns the same row twice inside one statement. Companion to ops_pgss_snapshot/ops_pgss_delta, which cover per-QUERY reads instead.';

CREATE OR REPLACE FUNCTION public.ops_db_io_snapshot(p_retain_days integer DEFAULT 90, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH ins AS (
    INSERT INTO public.audit_20260920_ops_db_io_snap (
      blks_read, blks_hit, xact_commit, xact_rollback, temp_files, temp_bytes, deadlocks,
      backends, io_wait_backends, active_backends, postmaster_start,
      shared_buffers_mb, work_mem_kb, note)
    SELECT d.blks_read, d.blks_hit, d.xact_commit, d.xact_rollback,
           d.temp_files, d.temp_bytes, d.deadlocks,
           (SELECT count(*) FROM pg_stat_activity),
           (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'IO'),
           (SELECT count(*) FROM pg_stat_activity WHERE state = 'active'),
           pg_postmaster_start_time(),
           (current_setting('shared_buffers')::bigint * 8 / 1024)::int,
           current_setting('work_mem')::int,
           p_note
    FROM pg_stat_database d
    WHERE d.datname = current_database()
    RETURNING 1)
  DELETE FROM public.audit_20260920_ops_db_io_snap
   WHERE captured_at < now() - make_interval(days => p_retain_days)
     AND (SELECT count(*) FROM ins) >= 0;
$$;

REVOKE EXECUTE ON FUNCTION public.ops_db_io_snapshot(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_db_io_snapshot(integer, text) TO postgres, service_role;

COMMENT ON FUNCTION public.ops_db_io_snapshot(integer, text) IS
'Takes one instance-level IO counter snapshot and prunes past the retention horizon, in one statement. Read rates with public.ops_db_io_rate().';

-- The reader. Returns per-interval RATES between consecutive snapshots, and marks a counter reset
-- (a restart with non-persisted stats) rather than emitting a negative delta that would sort to an
-- edge and read as a real value.
CREATE OR REPLACE FUNCTION public.ops_db_io_rate(p_since interval DEFAULT interval '48 hours')
RETURNS TABLE (
  window_start      timestamptz,
  window_end        timestamptz,
  secs              numeric,
  mb_per_sec        numeric,
  read_iops         numeric,
  cache_hit_pct     numeric,
  temp_mb_per_hour  numeric,
  io_wait_backends  integer,
  active_backends   integer,
  counter_reset     boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    prev_at, captured_at,
    round(extract(epoch FROM (captured_at - prev_at))::numeric, 1),
    CASE WHEN reset THEN NULL ELSE
      round((blks_read - prev_read) * 8192.0 / 1024 / 1024
            / nullif(extract(epoch FROM (captured_at - prev_at)), 0), 1) END,
    CASE WHEN reset THEN NULL ELSE
      round((blks_read - prev_read) / nullif(extract(epoch FROM (captured_at - prev_at)), 0), 0) END,
    CASE WHEN reset THEN NULL ELSE
      round(100.0 * (blks_hit - prev_hit)
            / nullif((blks_hit - prev_hit) + (blks_read - prev_read), 0), 2) END,
    CASE WHEN reset THEN NULL ELSE
      round((temp_bytes - prev_temp) / 1024.0 / 1024
            / nullif(extract(epoch FROM (captured_at - prev_at)) / 3600.0, 0), 1) END,
    io_wait_backends, active_backends, reset
  FROM (
    SELECT s.*,
           lag(s.captured_at) OVER w AS prev_at,
           lag(s.blks_read)   OVER w AS prev_read,
           lag(s.blks_hit)    OVER w AS prev_hit,
           lag(s.temp_bytes)  OVER w AS prev_temp,
           (s.blks_read < lag(s.blks_read) OVER w
            OR s.postmaster_start IS DISTINCT FROM lag(s.postmaster_start) OVER w) AS reset
    FROM public.audit_20260920_ops_db_io_snap s
    WHERE s.captured_at > now() - p_since
    WINDOW w AS (ORDER BY s.captured_at)
  ) q
  WHERE prev_at IS NOT NULL
  ORDER BY captured_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.ops_db_io_rate(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_db_io_rate(interval) TO postgres, service_role;
-- anon-exec: ops_db_io_rate — NEW function; EXECUTE revoked from PUBLIC, anon, authenticated above.

COMMENT ON FUNCTION public.ops_db_io_rate(interval) IS
'Per-interval instance IO rates from audit_20260920_ops_db_io_snap. Compare mb_per_sec / read_iops against the compute tier baseline: Small 22 MB/s / 1,000 IOPS, Medium 39 / 2,000, Large 79 / 3,600, XL 149 / 6,000. Sitting at the baseline with io_wait tracking active_backends means the tier is the constraint.';