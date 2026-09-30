-- audit_20260929_hybrid_custody_backfill_weekly_full_pages
--
-- Schedules hybrid-custody-backfill weekly over the FULL candidate set
-- (get_hybrid_custody_candidates(90): saved + active seeded + 90-day buyers and
-- sellers, 6,584 Flow addresses on 2026-09-29), which until now ran only by hand.
-- The daily job (rpc-hybrid-custody-backfill-wallets) covers saved + seeded; this
-- catches a trader whose Hybrid Custody link predates the event cursor
-- (2026-05-10) and who became a candidate later.
--
-- One invocation reads ~3,000 addresses in ~80 s (measured 2026-09-29), so the
-- set runs in three fixed pages, 10 minutes apart, Sunday 10:23 / 10:33 / 10:43
-- UTC (3:23-3:43 AM PDT). Offsets 0 / 2950 / 5900 with limit 3000: the 50-row
-- overlaps absorb the sorted candidate list moving between pages (it moved by
-- one during the 2026-09-29 manual run). Coverage ends at 8,900. The last page
-- carries last_page=1, so if the set outgrows it that run is ok=false and says
-- how many candidates went unread; it does not pass with the tail unread.
--
-- Same auth as the daily job: ?key=cron_gate_key('hybrid-custody-backfill').
-- No function is created or replaced here (no anon-exec decision to state).
--
-- Revert:
--   SELECT cron.unschedule(j) FROM unnest(ARRAY['rpc-hybrid-custody-backfill-all-p1','rpc-hybrid-custody-backfill-all-p2','rpc-hybrid-custody-backfill-all-p3']) j;
--   DELETE FROM public.edge_lane_watch WHERE jobname LIKE 'rpc-hybrid-custody-backfill-all-p%';

SELECT cron.schedule(
  'rpc-hybrid-custody-backfill-all-p1',
  '23 10 * * 0',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/hybrid-custody-backfill?key=' || public.cron_gate_key('hybrid-custody-backfill') || '&scope=all&offset=0&limit=3000', timeout_milliseconds:=30000); $cmd$
);
SELECT cron.schedule(
  'rpc-hybrid-custody-backfill-all-p2',
  '33 10 * * 0',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/hybrid-custody-backfill?key=' || public.cron_gate_key('hybrid-custody-backfill') || '&scope=all&offset=2950&limit=3000', timeout_milliseconds:=30000); $cmd$
);
SELECT cron.schedule(
  'rpc-hybrid-custody-backfill-all-p3',
  '43 10 * * 0',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/hybrid-custody-backfill?key=' || public.cron_gate_key('hybrid-custody-backfill') || '&scope=all&offset=5900&limit=3000&last_page=1', timeout_milliseconds:=30000); $cmd$
);

INSERT INTO public.edge_lane_watch (jobname, fn_name, outcome_table, outcome_column, max_age_hours, severity, note, observed_via, pipeline_name)
SELECT j, 'hybrid-custody-backfill', NULL, NULL, NULL, 'warn',
       'Weekly full-candidate child-side link read, one of three fixed pages; the last page fails if the set outgrows the schedule. The lane logs itself.',
       'pipeline_runs', 'hybrid_custody_backfill'
FROM unnest(ARRAY['rpc-hybrid-custody-backfill-all-p1','rpc-hybrid-custody-backfill-all-p2','rpc-hybrid-custody-backfill-all-p3']) j;
