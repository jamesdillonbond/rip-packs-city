-- 2026-10-19 (Claude Code cloud; Trevor: "Keep going"). Follow-up to 20261020044518.
--
-- AN EV-SNAPSHOT VERDICT HELD ~8 MINUTES IN EVERY 3 HOURS. pack_table_rows withdraws a refuted EV
-- snapshot only while chk.pev_snapshotted_at = the snapshot it reads from mv_pack_ev_latest. That MV
-- refreshes at :03 and :33 (rpc-refresh-mv-pack-ev-latest), picking up the hourly EV writers (:13
-- backfill, :25 atlas, :28 containers) at :33 -- but refresh_pack_supply_counter_checks ran only from
-- the Vercel route /api/cron/topshot-pack-dist-names-onchain at 25 */3, i.e. against the PREVIOUS
-- hour's stamps. So from each :33 refresh until the next 3-hourly :25 the newest snapshot had no
-- matching verdict and the view failed OPEN -- tonight's "0% sealed packs sold" fixes included.
--
-- Fix: also run the check hourly at :34, right after the :33 refresh (~12 s). No EV writer runs
-- between :33 and the :03 refresh, so the verdict then matches for ~59 minutes of every hour. Cost
-- ~23 s/hour (measured 2026-10-19). The 3-hourly route call stays (harmless; it also refreshes
-- after discovery adds a dist). Logged as pipeline 'pack-supply-counter-checks'.
--
-- Revert: SELECT cron.unschedule('rpc-pack-supply-counter-checks');
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'pack-supply-counter-checks';

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('pack-supply-counter-checks', 150, 'info',
  'pg_cron rpc-pack-supply-counter-checks (34 * * * * UTC, postgres) -> refresh_pack_supply_counter_checks() wrapped in log_pipeline_run, right after rpc-refresh-mv-pack-ev-latest (:33) so EV-snapshot verdicts match the stamps pack_table_rows reads. rows = verdict rows written (~3.2k); extra carries pd/pev/tier refuted counts. Also called 3-hourly by /api/cron/topshot-pack-dist-names-onchain.',
  true, 180)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-pack-supply-counter-checks', '34 * * * *',
  $cmd$SELECT public.log_pipeline_run('pack-supply-counter-checks', now(), (x.r->>'rows_written')::int, (x.r->>'rows_written')::int, 0, (x.r->>'ok')::boolean, NULL, NULL, NULL, NULL, x.r || jsonb_build_object('via', 'pg_cron')) FROM (SELECT public.refresh_pack_supply_counter_checks() AS r) x;$cmd$);
