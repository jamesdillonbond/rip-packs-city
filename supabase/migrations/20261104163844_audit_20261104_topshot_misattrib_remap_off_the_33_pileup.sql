-- audit_20261104_topshot_misattrib_remap_off_the_33_pileup
--
-- 2026-11-04 (Cowork cloud). rpc-topshot-misattrib-remap (jobid 721, daily, 101 s max / 79 s avg over 7 d;
-- pgss ~2.37M shared hits + ~118k reads per call) ran at 12:33 UTC, the same minute as two HOURLY jobs:
-- rpc-wmc-fmv-stuck-resync (:33, 80 s avg, 156 s that day) and rpc-refresh-mv-pack-ev-latest (3,33). Minute :33
-- of hour 12 UTC is the busiest minute of that hour (1,637 busy cron-s over 7 d vs 550 at the quietest).
-- 11-04 the two user-facing read timeouts of the night landed inside that window: market-cap tile on a Panini
-- edition page (12:37:03 UTC, 8 s bound; the same read measures 57 ms now) and the LaLiga franchise hub
-- (12:34:59 UTC, 4 s bound; 7 ms now). The remap has no ordering dependency (its input map is filled
-- continuously by resolve_topshot_misattrib_via_atlas), so it moves to 05:53 UTC, the quietest scored minute
-- in the quietest hours (hour 5 :53 = 321 busy-s over 4 d, away from every :3/:33 hourly).
-- Same jobname => jobid 721 is preserved. Verify by its next tick in cron.job_run_details (05:53 UTC).
--
-- REVERT: SELECT cron.schedule('rpc-topshot-misattrib-remap', '33 12 * * *', 'SELECT public.remap_topshot_from_onchain_map();');

SELECT cron.schedule('rpc-topshot-misattrib-remap', '53 5 * * *', 'SELECT public.remap_topshot_from_onchain_map();');
