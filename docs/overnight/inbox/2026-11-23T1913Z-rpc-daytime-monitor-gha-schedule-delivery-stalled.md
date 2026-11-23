# GHA schedule delivery stalled ~9.5h — pg_cron watchdog correctly alarming, backstops holding

**Filed:** 2026-11-23 ~11:13 AM PT (rpc-daytime-monitor, read-only daytime sweep)

**Source:** `pipeline_runs` `gha-schedule-watchdog` (pg_cron `rpc_gha_schedule_watchdog()`, `8,38`) — `ok=false` verdict `stalled` since the 16:08Z run; `rpc_ops_snapshot()` `running_but_not_succeeding` medium arm flags the same row. Last `schedule`-tagged GHA tick 2026-11-23 09:50:11Z (~1:50 AM PT); 558 min silent at the 19:08Z read, `scheduled_ticks_6h`=0. Known class: known-issues #80 (GitHub sheds `schedule` events estate-wide; this pg_cron watchdog is the independent detector built for exactly this, so a stalled read here is the instrument WORKING).

**What:** GitHub Actions delivered no `schedule`-tagged tick to the repo in ~9.5h. The watchdog runs on pg_cron (independent scheduler, unaffected) and reads `stalled`.

**Blast radius (read, not guessed):** no REAL cadence fallout. `detect_stalled_pipelines()` lists only `topshot-buyer-backfill-historical` (info), deliberately PAUSED this morning (job 7866110, ledger 11-23 ~8:15 AM PT) — expected silence, not GHA-caused. The watchdog's `cadence_breach_count` ticked 0->1 at 19:08Z = that same paused lane crossing its 183-min threshold, not a live lane. Sales/market/sentinel lanes have cron-job.org / pg_cron primaries and are current (snapshot: trust 0 breaches, FMV/editions fresh, security []). Exposure is GHA-schedule-ONLY lanes silently skipping: `e2e-smoke` (every 6h :51 — the 12:51Z & 18:51Z slots), and daily GHA-only syncs/detectors if the stall outlasts their next slot. The detector-health trio (`edge-fn-drift`/`db-pin-staleness`/`migration-parity`) all ran today BEFORE 09:50Z, so they are covered this cycle.

**Risk read:** LOW-to-MEDIUM, mitigated by design. This is #80's class with the watchdog + cron-job.org backstops doing their job. NOT a code/DB defect; no RPC change warranted. Cost while it persists: the E2E DOM Smoke badge goes stale and GHA-only lanes miss ticks. The structural risk is duration, not any single missed run.

**Suggested action (night pass / Trevor — sensing-only from here):**
1. Confirm whether this is a GitHub Actions platform scheduler shed (githubstatus.com) vs a workflow broken by a morning commit — the simultaneous stop of ALL schedules points GitHub-side, per #80.
2. If it persists past the next `e2e-smoke` / daily-sync slots, confirm those GHA-only lanes have a non-GHA caller or fire them via `workflow_dispatch`.
3. No action if it self-clears — the watchdog returns `delivering` the moment a `schedule` tick lands.

Not a spell: `rpc_ops_snapshot()` returned fast and IO is not saturated.
