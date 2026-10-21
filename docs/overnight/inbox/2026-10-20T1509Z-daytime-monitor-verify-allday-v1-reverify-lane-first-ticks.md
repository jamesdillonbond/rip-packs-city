# Daytime monitor — 2026-10-20 ~15:09Z — GREEN sweep, one watch candidate

Read-only 3h health pass. Infra GREEN: security clean (invariants/anon_write/rls_off/secdef_anon all `[]`), `detect_stalled_pipelines()` `[]`, `check_pgcron_recent_failures()` `[]`, sentinel TS-UUID 48h = 0, client-error beacon 0/24h (and 0 prior 24h). Trust health 36/37 ok; the one BREACH is `candy_sales_stale_hours` 203.8h = the known #58 (OpenSea key, Trevor-owned — do NOT re-file). `backward_cursor_rewinds` lists only `topshot_missing_fill_offers_walk` = the deliberate weekly Monday re-seed (focus 10-19 steer). Latest Vercel prod deploy READY. The two in-place-spliced functions from today's newest deploy (`get_platform_stats`, `analytics_fmv_tier_pulse`) both execute with sensible populated data. `public_board_empty_count` = 0 and `public_board_slow_count` = 0, so today's large All Day V1 listing surgery (#197/#198) left no board empty or stale.

## Candidate 1 — WATCH: confirm the first ticks of the new hourly All Day V1 reverify lane (shipped today, after the overnight handoff)

- **Title:** Verify `rpc-allday-v1-listing-reverify` (pg_cron 762) first ticks succeed and drain as designed.
- **Source:** pg_cron jobid 762 `rpc-allday-v1-listing-reverify`, schedule `24 * * * *` -> `allday_v1_reverify_tick(12)`; migration `20261020144618` (#198), prod deploy READY. Created 14:46Z — *after* the 08:13Z overnight handoff, so it is not yet carried on any watch list.
- **State observed:** job is registered + `active=true` with a valid schedule but had **no run yet** at 15:08Z (first tick due 15:24Z). Expected for a just-created hourly job, **not** a finding this pass.
- **Risk read:** low. New infra that drains its own Flow REST scripts against the live All Day V1 listing surface, closes ghosted/vanished/purchased rows, and re-checks rows >7d. Read-only to re-verify; the write path is the tick itself.
- **Suggested action (night pass / next tick):** read `cron.job_run_details` for jobid 762 and `pipeline_runs` for the lane — expect `ok=true` and rows stamped `live` / closed ghosted-vanished-purchased. Fold into the existing recent-ship watch for #197/#198. File a real finding only if the first several ticks are `ok=false` or the lane wedges; otherwise close the watch.

## Drained 2026-10-20 — confirmed
`allday-v1-listing-reverify` (pg_cron 762): 12 runs, 12 ok, 8:24 AM → 7:24 PM PT 10-20 (read ~8:00 PM PT, Cowork cloud). The first real dispatch (V1 asks older than 7 days) is due ~10-27 8:24 AM PT — the dated check in #198.
