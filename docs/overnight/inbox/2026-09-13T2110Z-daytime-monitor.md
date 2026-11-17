# Daytime monitor — 2026-09-13T21:10Z (2:10 PM PT)

Read-only sweep. **In a saturation spell** (positive control: 7/10 active sessions in IO wait at 21:07Z; `check_maintenance_load().io_waiters = 10` at 21:10Z). Per Section 1c everything below is filed as a **SYMPTOM** — no cause, cost, or "cheap/expensive" judgment is asserted, and every action is a **quiet-window RE-MEASURE**. `inbox written to mount, push unavailable` (sandbox shell down — the Sept-8 Windows-update mount break, 5th night; git-clone path unusable, wrote to mounted tree instead).

## Candidate 1 — afternoon IO saturation with NO maintenance op running (distinct from the morning's #75 TOAST-autovacuum spell)

- **Source:** `rpc_ops_snapshot()` + `check_maintenance_load()` + `check_pgcron_recent_failures()`, 21:06–21:10Z.
- **Observed (symptom, not cause):**
  - `check_maintenance_load()` @21:10Z: `vacuums:[]`, `clusters:[]`, `index_builds:[]`, `autovacuum_workers:0` — **yet `io_waiters:10`.** So the current IO pressure is running with **no maintenance operation of any kind active.**
  - Today's ledger attributes the multi-hour morning spell to the first-ever autovacuum of `net._http_response`'s 12.4 GB TOAST (register #75) and records it "ended at 12:05 PM PT … the cause ended but the instance did not calm." This 2:10 PM PT reading is a **second, later window of IO saturation that is NOT explained by a running maintenance op** — the morning cause is complete (0 autovacuum workers).
  - pg_cron 6h failures are a **cluster of `canceling statement due to statement timeout` + one `job startup timeout`, no logic errors** → saturation collateral, not N distinct bugs (CLAUDE.md 1a). Jobs seen failing on the timeout: `rpc-wmc-parallel-rekey` (14/48), `rpc-reconcile-saved-wallet-stats` (7/24), `rpc-allday-dist-opened-expiry` (startup timeout 4/7), the two pack-sales-agg MV refreshes, `rpc-thp-leg-impossible-parallel`, `rpc-backfill-pinnacle-mint-acquisitions`, `rpc-allday-ev-corrected-refresh`.
- **Not truly stalled (checked, so the night pass doesn't chase it):** `ts-listings-atlas-sync` (TS sniper feed, 2-min) and `reconcile-saved-wallet-stats` (hourly :44) show as "silent" in `pipeline_runs` only because the timeout aborts before the terminal-row write. In `cron.job_run_details` both pg_cron jobs are **still firing on cadence** (ts-listings ticking every 2 min through 19:46Z, reconcile firing hourly) — they just keep timing out. Silence in `pipeline_runs` here is the censoring artifact, not a stopped scheduler.
- **Risk read:** LOW to act on now (read-only sweep; no action taken). The risk is *mis-attribution* — concluding "the spell was the #75 TOAST vacuum and it's over" when a workload-only saturation window recurred this afternoon with no maintenance op behind it.
- **Suggested action (quiet-window RE-MEASURE, do NOT conclude from this spell):** in a window where `io_waiters` is low and `pg_stat_activity` shows no IO-wait majority, re-measure whether the heavy-cron band alone saturates the Small-tier IO budget absent any maintenance op — i.e. is there a workload-only saturation this afternoon, separate from the #75 TOAST autovacuum, that survives after tonight's planned `VACUUM FULL`? Size the offending queries by **BUFFERS**, warm-vs-warm, with the tree frozen (not while this probe is itself adding IO). If confirmed workload-only, it is a cron-band scheduling / query-cost item, not a maintenance one.

## Trust-health breaches (3) — all read consistently with the spell; none re-filed as new bugs

- `public_board_slow_count = 9` (breach_at 1) — boards reading slow under IO pressure. `public_board_empty_count = 0`, so users see stale-but-present data, not an honesty/empty-state violation. **Symptom of the spell**; re-measure in a quiet window before treating any board as individually slow.
- `topshot_impossible_parallel_serials = 29` (breach_at 3) — **KNOWN #82**, up from 5, repair Trevor-gated; carried in the released nightly ledger. **Not re-raised.**
- `trust_precompute_max_age_hours = 14.31` (breach_at 13) — 1.3h over; the precompute refresh very likely timed out inside the spell. Folds into Candidate 1; not separately filed.

## Everything else green

- Security 4/4 clean (`invariants`, `anon_write_holes`, `rls_off_base_tables`, `secdef_anon_violations` all `[]`).
- `sentinel_ts_uuid_editions_48h = 0`; `ts_uuid_dupes_created_24h = 0`.
- Vercel: no ERROR deployments in the last 20; most recent READY deploys healthy (`lambdaRuntimeStats` present). Two QUEUED + one BUILDING at the tip are normal rapid-push stacking (a concurrent session + Trevor pushing to main); CANCELED entries are superseded, expected.
- Editions by collection: nba_top_shot 14015, nfl_all_day 6190, laliga_golazos 575, ufc_strike 518, candy_mlb 125. DB size 30,259 MB.

## Not done (spell discipline)

- **Artifact payload validation SKIPPED this run** (Section 1b): re-running heavy payload queries in an active spell only stacks IO onto the saturation, and a timeout would be a symptom, not a broken artifact. Re-validate the 13 active artifacts in a quiet window.
- No first-tick-of-day (1a) extras — this is an afternoon tick.
