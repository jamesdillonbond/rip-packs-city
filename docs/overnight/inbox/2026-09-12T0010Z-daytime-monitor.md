# Daytime monitor — 2026-09-12T00:10Z (2026-09-11 17:10 PT)

Environment: bash/clone mount down (Sept-8 Windows update). Repo read via file tools; **inbox written to mount, push unavailable** — night pass picks up locally.

**IN A SATURATION SPELL** — positive control at 00:06Z: `pg_stat_activity` = 7/7 active sessions in IO wait. Per Section 1c, everything below is filed as a SYMPTOM; no causal/cost conclusion is asserted, and each action is a quiet-window re-measure, not a fix.

## Candidates

### 1. `snapshot-institutional-wallets` missed its 2026-09-11 10:07Z daily run — HIGH (absence, likely self-clearing)
- **Source:** `rpc_ops_snapshot()` pipeline_alerts (`cron_silent`, silent 2279 min vs 1800 min threshold) + `pipeline_runs` lookup.
- **Observed:** clean daily runs 09-09 10:07Z (ok, 3 rows) and 09-10 10:07Z (ok, 3 rows); the 09-11 10:07Z run is **absent entirely** — no failed row, no error. This is an external cron-job.org daily trigger, and its own query is light (writes 3 rows), so it is *not* obviously its own-query-cost collateral of the spell.
- **Risk:** low blast radius (institutional-wallet snapshot, 3 rows/day, one missed day). Read-only diagnostic.
- **Suggested action (quiet-window):** night pass verify whether the cron-job.org daily job fired on the 11th; if it fired *into* a spell window and aborted before the `pipeline_runs` write, it self-clears on the next 10:07Z tick. Only escalate if 09-12 10:07Z is also absent.

### 2. Saturation spell is PERSISTENT/RECURRING ~11h after the 13:30Z filing (#84) — SYMPTOM, already owned
- **Source:** positive control (7/7 IO wait) + `check_pgcron_recent_failures()` cluster (13 jobs, all `statement timeout` / `job startup timeout`, zero logic errors) at 17:10 PT.
- **Not a new item.** This is the same spell the 2026-09-11 13:30Z ledger entry / register #84 documents (pg_cron jobid 355 `backfill_pinnacle_trade_acquisitions(50000)`, batch-50000 → IO saturation → WAL-write stall). Filing only the **new datapoint**: the spell is still/again active in the evening (00:06Z), so a quiet window for the BUFFERS-based batch-size measurement #84 defers may be hard to catch during active hours — the night pass's low-traffic window is the right place to size that lever.
- **Do NOT re-open #84 as new; do NOT size the batch on any timing read during the spell.**

## Known breaches — NOT re-filed (already ledgered 2026-09-11)
- `topshot_impossible_parallel_serials` = 4 (breach_at 3) → register **#82**; self-heal now honestly reports `raised:0, attempted:4`; actual repair (`remap_topshot_parallel_to_base_misattributed`) is Trevor's call.
- `public_board_slow_count` = 11 (breach_at 1) → spell symptom (boards slow, not empty: `public_board_empty_count` = 0).
- `trust_precompute_max_age_hours` = 17.3 (breach_at 13) → spell collateral (precompute refresh jobs timing out).
- `fmv-backfill` 71.4% / `price-snapshots` 28.6% fail (both `statement timeout`) → spell collateral.
- `atlas-*-upstream-403`, `flow-rest-moment-moved-400`, `match-topshot-players` running-but-not-succeeding → all carry ATTRIBUTED/by-design annotations in the snapshot; not findings.
