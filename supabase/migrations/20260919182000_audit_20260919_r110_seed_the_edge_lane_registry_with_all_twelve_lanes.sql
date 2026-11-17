-- audit_20260919_r110_seed_the_edge_lane_registry
--
-- RECORD-ONLY as applied (the rows went in via `execute_sql`, which writes no
-- `schema_migrations` row), but written idempotently so a database rebuilt from
-- migrations reproduces the registry rather than starting with a ban that fires
-- on all twelve lanes.
--
-- ⚠ THIS FILE IS THE CURATED PART. `check_edge_lane_observability()` is generic;
-- the judgement lives here, in which lane is watched how and why. Read the notes
-- before changing a bound - several encode a measurement, not a preference.
--
-- ⚠ Two rows are deliberately `observed_via = 'none'`, and that is a STANDING,
-- NAMED GAP rather than an oversight. The sentinel arm states them without
-- paging, because a permanently-amber arm is an unreadable one.

INSERT INTO public.edge_lane_watch
  (jobname, fn_name, observed_via, outcome_table, outcome_column, max_age_hours,
   pipeline_name, severity, note)
VALUES
  ('rpc-topshot-pack-sales-backfill','backfill-topshot-pack-sales','outcome_freshness',
   'topshot_pack_sales_history','block_time',24,NULL,'critical',
   'Was DEAD 6 days behind a terminal done latch (2026-09-13..19). Top Shot pack sales land EVERY day (105-804/day over 08-01..09-13, zero empty days), so 24h is already abnormal. Belt-and-braces: the sentinel arm "Pack Sales Ingest (Top Shot)" watches the same thing via unlatch_pack_sales_cursors.'),
  ('rpc-allday-pack-sales-backfill','backfill-allday-pack-sales','outcome_freshness',
   'allday_pack_sales_history','block_time',168,NULL,'critical',
   'Was DEAD 7 days behind the same latch. All Day is thin - 1-25 sales/day with 7 empty days in six weeks and a worst normal gap near 3 days - so 168h is the tightest honest bound. Also covered by the sentinel arm "Pack Sales Ingest (All Day)".'),
  ('rpc-allday-resolve-pull-editions','resolve-allday-pull-editions','outcome_freshness',
   'allday_pack_pull','updated_at',24,NULL,'warn',
   'Outcome table INFERRED, not proven: the lane resolves editions for All Day pack pulls and allday_pack_pull.updated_at read 1.6h fresh on 2026-09-19 while the lane runs 9,39 hourly. It may have other writers, which would make this signal weaker than it looks - if it ever fires, confirm the writer before acting. 24h leaves ~15x headroom over the observed lag.'),
  ('rpc-allday-dist-opened-backfill','backfill-allday-dist-opened','none',
   NULL,NULL,NULL,NULL,'info',
   'NO OUTCOME CHECK ON PURPOSE. Its pack_opens_api_state rows have been done=true since 2026-07-11/12 at 2,814,815 packs seen, and that is CORRECT: a forward lane carries the head (allday-pack-opens-forward, 41 ok runs/24h). Unlatching it would restart a 2.8M-row walk for nothing. Its cost is 360 no-op dispatches/day, which is waste, not an outage.'),
  ('rpc-allday-resolve-rip-dist-api','resolve-allday-rip-dist-api','none',
   NULL,NULL,NULL,NULL,'warn',
   'NO OUTCOME CHECK because I could not identify its target table with confidence on 2026-09-19. A manual dispatch returned {"ok":true} so it is not latched, but that is a self-report, not an outcome. THIS ROW IS THE OPEN WORK: identify what it writes and wire a freshness bound. Candidates looked at and not confirmed: allday_rip_rollup_state (8 kB, no timestamp column), pack_rips.'),
  ('rpc-compute-pinnacle-pack-ev','compute-pinnacle-pack-ev','pipeline_runs',
   NULL,NULL,NULL,'compute-pinnacle-pack-ev','warn',
   'Covered by the sentinel pipeline arms. Pipeline name matched to the job by name AND cadence (17 */6) on 2026-09-19.'),
  ('rpc-compute-golazos-pack-ev','compute-golazos-pack-ev','pipeline_runs',
   NULL,NULL,NULL,'compute-golazos-pack-ev','warn',
   'Covered by the sentinel pipeline arms. Matched by name and cadence (37 */6) on 2026-09-19.'),
  ('rpc-allday-pack-opens-forward','ingest-allday-pack-opens','pipeline_runs',
   NULL,NULL,NULL,'allday-pack-opens-forward','warn',
   'Covered by the sentinel pipeline arms. Matched by start-minute alignment (9,39) on 2026-09-19 - this is the FORWARD lane that makes rpc-allday-dist-opened-backfill''s done=true correct.'),
  ('rpc-topshot-pack-opens-history','ingest-topshot-pack-opens-history','pipeline_runs',
   NULL,NULL,NULL,'topshot-pack-opens-history-backfill','warn',
   'Covered by the sentinel pipeline arms. Matched by name and cadence (11,26,41,56) on 2026-09-19.'),
  ('rpc-backfill-pack-supply','backfill-topshot-pack-supply','pipeline_runs',
   NULL,NULL,NULL,'topshot-pack-supply-backfill','warn',
   'Covered by the sentinel pipeline arms. Daily at 15 8; matched by name on 2026-09-19.'),
  ('rpc-pinnacle-mints-forward','ingest-pinnacle-mints','pipeline_runs',
   NULL,NULL,NULL,'ingest-pinnacle-mints-forward','warn',
   'Covered by the sentinel pipeline arms. Shares its edge function with rpc-pinnacle-mints-backfill but logs a distinct pipeline name.'),
  ('rpc-pinnacle-mints-backfill','ingest-pinnacle-mints','pipeline_runs',
   NULL,NULL,NULL,'ingest-pinnacle-mints-backfill','warn',
   'Covered by the sentinel pipeline arms. Shares its edge function with rpc-pinnacle-mints-forward but logs a distinct pipeline name.')
ON CONFLICT (jobname) DO UPDATE SET
  fn_name = EXCLUDED.fn_name, observed_via = EXCLUDED.observed_via,
  outcome_table = EXCLUDED.outcome_table, outcome_column = EXCLUDED.outcome_column,
  max_age_hours = EXCLUDED.max_age_hours, pipeline_name = EXCLUDED.pipeline_name,
  severity = EXCLUDED.severity, note = EXCLUDED.note, is_active = true;
