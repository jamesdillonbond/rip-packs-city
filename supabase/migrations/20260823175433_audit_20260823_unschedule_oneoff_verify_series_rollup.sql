-- Verified: two runs under cron_heavy, 76 s cold (including the
-- edition_fmv_current rebuild) and 2 s warm, against a 240 s budget and
-- cron_heavy's 600 s ceiling. Remove the one-off.
SET LOCAL ROLE cron_heavy;
SELECT cron.unschedule('rpc-oneoff-verify-series-rollup');
RESET ROLE;