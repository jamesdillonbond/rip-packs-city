# Daytime monitor candidate — 2026-09-28 ~15:15Z (08:15 PT, first-tick-of-day pass)

Read-only sweep GREEN except one new, unsuppressed cursor_stalled HIGH. Not in ledger; not on the Declined list. sync-nba-projections `all_upstreams_failed` was checked and NOT logged — it is known-issue #8 (NBA free feeds dead since 08-04, shelved 09-23, alert muted, no paid provider before revenue).

## Candidate 1 — topshot_offer_fill_backfill cursor_stalled 7.5h (unsuppressed backfill catch-up)

- **Title:** `topshot_offer_fill_backfill` cursor has not advanced in 7h28m (past the 6h `cursor_stalled` threshold); the alert is live because this backfill has no `pipeline_alert_suppression` row (unlike its three sibling backfills).
- **Source:** `rpc_ops_snapshot()` → `pipeline_alerts` (type `cursor_stalled`, severity `high`, "Cursor updated 07:25:37 ago at block 165997151"). Confirmed via `event_cursor`: id `topshot_offer_fill_backfill`, block 165997151, updated 2026-09-28T07:39:02Z. `event_cursor_watermarks`: `ever_decreased=false`, `rewind_count=0` (clean, no rewind pathology). No rows in `pipeline_runs` under this name.
- **Risk read: LOW.** This is a catch-up BACKFILL lane, not live capture. The live offer indexers are current: `topshot_offers` block 166029651 (age ~15m), `allday_offers` block 166029269 (age ~20m) — so no real-time offer data is being lost. The backfill sits ~32.5k blocks behind live and last moved 07:39Z. Ledger shows this lane moves in intermittent bulk sweeps (offer-fill-backfill.yml, capped GHA; ran 7-9x/24h historically), so a >6h pause trips the threshold without a genuine stop. But it is unsuppressed and not a known-declined item, so it warrants a disposition.
- **Suggested action (night pass):** Check whether `offer-fill-backfill.yml` GHA is still scheduled and running (recent workflow runs) vs silently stopped. Then pick one: (a) if it silently stopped, restart/re-enable it; (b) if it has drained its available work / is intermittently correct, add a `pipeline_alert_suppression` row like its siblings (`audit_20260705_suppress_ts_base_parallel_probe_cursor_stalled`, `_allday_pack_opens_backfill_cursor_stalled`, `audit_20260716_suppress_pinnacle_backfill_cursor_alert`) so it stops false-tripping. Read-only sense-and-log only — daytime monitor took no action.

### Sweep context (2026-09-28 ~15:15Z)
- Security invariants / secdef_anon / rls_off_base / anon_write_holes: all `[]` (clean)
- Trust health: all metrics `ok`, breaches `[]`; sentinel TS-UUID editions 48h = 0
- detect_stalled_pipelines: `[]`; check_pgcron_recent_failures: `[]`
- Cross-collection refresh (first-tick): cohort_mat 188 rows @10:02Z, overlap_mat @10:35Z (both fresh; step1+step2 succeeded), both jobs active
- Vercel: latest production deploy `03693513` READY, no ERROR in recent 8 (Trevor shipping this morning: Pinnacle serials #156, get_set_activity bounds, panini watchdogs, allday paging, cache-refresh — none correlating with a regression)
- Sentry: no unresolved issues in last 6h
- Artifact backing objects: all present (structural validation)
- DB size 22,812 MB
- Not in a saturation spell (rpc_ops_snapshot returned promptly)

---

## Disposition — Claude Code, 2026-09-28 ~9:10 AM PT

**RESOLVED on its own; no suppression added.** Re-read live at 9:09 AM PT:

- `offer-fill-backfill.yml` asks for `9,24,39,54 * * * *` but GitHub delivered **no scheduled run between 12:37 AM and 8:58 AM PT** (runs: 09-28 07:37Z, then 15:58Z; ~3–7 a day for the last three days). That is the documented GHA-schedule shedding (memory `gha-schedules-are-not-honoured`: ~15 % of slots start on time), not a stopped lane. The 8:58 AM PT run succeeded.
- `event_cursor.topshot_offer_fill_backfill` moved to block **166,034,680** at 8:59:55 AM PT, **ahead of** the live `topshot_offers` cursor (166,034,153). It is caught up; no offer data was lost (the live indexers stayed current throughout, as the filing says).
- **Why not a `pipeline_alert_suppression` row like the siblings:** the alert was TRUE. The lane did not run for ~8 h, and a suppression is a claim the detector is wrong. If this lane's timing ever matters, the lever is to move it off GHA (pg_cron / cron-job.org honour schedules), not to silence the stall arm.
