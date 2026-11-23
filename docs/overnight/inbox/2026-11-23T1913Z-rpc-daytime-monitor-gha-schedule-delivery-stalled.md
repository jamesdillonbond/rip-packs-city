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

---

## ✅ TRIAGED 2026-11-23 ~11:40 AM PT (Claude Code cloud; Trevor: "Figure these out yourself") — GitHub is SHEDDING the two probe workflows, not stalled repo-wide; no change

- **Delivery is not stopped.** `schedule` runs landed this morning: RPC Ops Monitor 10:43 AM PT, DB pin staleness 11:20, institutional-wallets backstop 11:22, migration auto-recover 11:23, migration parity 11:27.
- **What the watchdog counts.** `rpc_gha_schedule_watchdog()` reads only `sentinel-heartbeat` + `dead-lane-backstop-heartbeat`. Those two workflows (crons `34-34 * * * *` and `12-12,27,42,57 * * * *`) are the repo's most-shed. GitHub delivered them only every 4–8 h over 11-21 → 11-23 (Sentinel: 2:19 PM, 6:37 PM, 3:55 AM, 11:56 AM, 5:06 PM, 1:43 AM PT). None since ~1:50 AM PT, which reads as `stalled`. **The verdict is correct for its probe set**; it means "the GHA-only probes are shed", the #80 class.
- **Blast radius (the #80 definition: lanes whose ONLY caller is a GHA schedule), read 11:35 AM PT:**
  - Freshness lanes have non-GHA primaries and are on cadence: `allday-listings-indexer` 24 runs / 6 h; `pinnacle-owner-discovery-forward` (cron-job.org) 12 / 6 h; `topshot-active-listings-ingest` last 11:13 AM.
  - Silent are only the two **historical backfills** that live on GHA alone: `pinnacle-owner-discovery` (backward scan, last 2:38 AM) and `topshot-sales-history-backfill` (last 11:53 PM 11-22). Each normally runs ~every 7 h (10 / 72 h). Cost = history arrives later, nothing user-visible.
  - The pager is unaffected: Sentinel's primary is cron-job.org `:04`.
- **The Sentinel run that did land (1:43 AM PT) was CRITICAL on Cadence Collapse** (7 `wallet-backfill*` lanes at ~39 %). That was a window artifact of batch bursts, already read by Cowork (focus.md 11-23: do NOT exempt). It cleared by 4 AM, and the arm reads 0 degraded at 11:30 AM.
- **Decision: no change.** Self-clears when a `schedule` tick of either probe lands. Escalate only if a FRESHNESS lane loses its non-GHA caller, or if the two backfills stay silent > 24 h (then `workflow_dispatch` them).
