-- 2026-09-25 (PT) — #137 (c): the QA pass's backup tables drop one week out,
-- on a one-shot pg_cron job at 10:05 AM PT Thu 2026-10-02 (17:05 UTC), which
-- unschedules itself.
--
-- ⚠ NOT DROPPED, although #137 (c) listed it: audit_20260925_edition_player_link_backup.
-- It is not a backup — link_editions_to_players_by_name (pg_cron
-- rpc-link-editions-to-players, daily) INSERTs every link it makes into it, so
-- dropping it would fail the linker every morning. It is the linker's log.
--
-- Dropped: the 24/25 player merge + name/series/team/pack-name/fmv fills'
-- backups, the Curry merge's two (20260925135939), wmc_series_backfill_state and
-- the retired walk's handler backfill_wmc_series_batch(integer) (its pg_cron job
-- rpc-wmc-series-backfill unscheduled itself 12:40 AM PT 09-25).
--
-- The job re-checks at run time: a table that a live function's body names is
-- SKIPPED with a WARNING rather than dropped (a writer may have adopted it by
-- then, as the linker did this one). DROP ... IF EXISTS throughout, so a table
-- already gone is a no-op. Outcome: cron.job_run_details for the job name.
-- Cancel before it fires: SELECT cron.unschedule('rpc-drop-20260925-qa-backups');

SELECT cron.schedule(
  'rpc-drop-20260925-qa-backups',
  '5 17 2 10 *',
  $job$
DO $body$
DECLARE
  t text;
  v_tables text[] := ARRAY[
    'audit_20260924_unknown_player_editions_backup',
    'audit_20260924_unknown_players_backup',
    'audit_20260924_dup_players_backup',
    'audit_20260924_dup_player_editions_backup',
    'audit_20260925_edition_name_fill_backup',
    'audit_20260925_fmv_fossil_repair_backup',
    'audit_20260925_ts_pack_dist_names_backup',
    'audit_20260925_ts_set_series_backup',
    'audit_20260925_ts_team_name_backup',
    'audit_20260925_dup_players_v2_backup',
    'audit_20260925_dup_player_editions_v2_backup',
    'audit_20260925_curry_player_backup',
    'audit_20260925_curry_editions_backup'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prosrc LIKE '%' || t || '%') THEN
      RAISE WARNING 'skipping %: a live function body names it', t;
    ELSE
      EXECUTE format('DROP TABLE IF EXISTS public.%I', t);
    END IF;
  END LOOP;

  DROP FUNCTION IF EXISTS public.backfill_wmc_series_batch(integer);
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prosrc LIKE '%wmc_series_backfill_state%') THEN
    RAISE WARNING 'skipping wmc_series_backfill_state: a live function body names it';
  ELSE
    DROP TABLE IF EXISTS public.wmc_series_backfill_state;
  END IF;

  PERFORM cron.unschedule('rpc-drop-20260925-qa-backups');
END
$body$;
$job$
);
