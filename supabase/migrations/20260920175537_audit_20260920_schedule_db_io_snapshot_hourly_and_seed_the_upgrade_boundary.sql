-- audit_20260920_schedule_db_io_snapshot_hourly_and_seed_the_upgrade_boundary
-- No function is created here; ops_db_io_snapshot / ops_db_io_rate were created, revoked and
-- (for the snapshot) body-fixed in the two audit_20260920_* migrations immediately preceding.
--
-- Minute :09 is deliberate: rpc-pgss-snapshot already owns ':05', and the two instruments should
-- not read the counters in the same minute or each appears inside the other's window.
SELECT cron.schedule('rpc-db-io-snapshot', '9 * * * *', 'SELECT public.ops_db_io_snapshot(90)');

-- Seed row. The note carries the boundary so a later reader can tell Small rows from Large rows
-- using the table alone, without having to find this migration.
SELECT public.ops_db_io_snapshot(
  90,
  'BOUNDARY: compute Small -> Large, restart 2026-09-20 10:39:56 PT. Pre-upgrade hand measurement '
  || '(two samples, separate transactions, 60.7 s, during a live spell, 17:23:27Z-17:24:28Z): '
  || '20.4 MB/s, 2607 read IOPS, 83.3 pct live cache hit, io_wait 16 of 16 active. '
  || 'Small published baseline 22 MB/s / 1000 IOPS; Large 79 / 3600. '
  || 'This row itself is POST-upgrade and taken on a COLD cache - do not read it as steady state.');