-- audit_20260929_hybrid_custody_backfill_daily_wallets_lane
--
-- Schedules hybrid-custody-backfill daily for saved + seeded wallets.
--
-- Why: linked_accounts gets links from two writers. hybrid-custody-events sees
-- only AccountUpdated events after its cursor started (block 151,110,101,
-- 2026-05-10). hybrid-custody-backfill reads current chain state, but only
-- when someone runs it by hand. So a wallet saved AFTER the last manual run,
-- whose Hybrid Custody link predates 2026-05-10, had no row until the next
-- run (2026-09-29: 140 of 147 such links were missing before the child-side
-- fix and a manual run). The wallets scope is ~264 addresses and ~9 s.
--
-- Auth: the function accepts ?key= equal to cron_gate_key('hybrid-custody-backfill'),
-- which it reads back from Vault with its service-role client. The key is
-- GENERATED HERE, inside Postgres. It is not a copy of any other secret and
-- never appears in this file, the transcript or an env var.
--
-- No function is created or replaced here (no anon-exec decision to state).
--
-- Revert:
--   SELECT cron.unschedule('rpc-hybrid-custody-backfill-wallets');
--   DELETE FROM public.edge_lane_watch WHERE jobname = 'rpc-hybrid-custody-backfill-wallets';
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'hybrid_custody_backfill';
--   DELETE FROM vault.secrets WHERE name = 'cron_gate_key__hybrid-custody-backfill';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cron_gate_key__hybrid-custody-backfill') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'cron_gate_key__hybrid-custody-backfill',
      'Generated in-DB 2026-09-29; hybrid-custody-backfill reads it back via cron_gate_key() to check ?key=.'
    );
  END IF;
END $$;

-- 13:19 UTC = 6:19 AM PT (5:19 AM PST). The minute is shared only with the
-- every-minute lanes; the job is one http_get, and the function returns 202.
SELECT cron.schedule(
  'rpc-hybrid-custody-backfill-wallets',
  '19 13 * * *',
  $cmd$ SELECT net.http_get(url:='https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/hybrid-custody-backfill?key=' || public.cron_gate_key('hybrid-custody-backfill') || '&scope=wallets', timeout_milliseconds:=30000); $cmd$
);

INSERT INTO public.edge_lane_watch (jobname, fn_name, outcome_table, outcome_column, max_age_hours, severity, note, observed_via, pipeline_name)
VALUES ('rpc-hybrid-custody-backfill-wallets', 'hybrid-custody-backfill', NULL, NULL, NULL, 'warn',
        'Daily saved+seeded child-side link read; writes are upserts, so linked_accounts freshness would not move on a quiet day. The lane logs itself.',
        'pipeline_runs', 'hybrid_custody_backfill');

-- Daily lane: silent after 26 h (one missed tick plus slack), no success in
-- 50 h (two missed ticks). Both sit inside pipeline_runs' ~73 h retention.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES ('hybrid_custody_backfill', 1560, 3000, 'medium',
        'Seeded 2026-09-29: pg_cron daily 13:19 UTC (scope=wallets). ok=false means a probe error or a failed write; read extra.error_samples.');
