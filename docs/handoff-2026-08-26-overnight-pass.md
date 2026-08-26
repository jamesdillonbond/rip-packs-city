# Overnight pass handoff — 2026-08-26 (cloud, NO-PUSH)

> ⚠ **Scope of the push blocker:** this run was a cloud Cowork session whose mount had **no `remote.origin.pushurl`** (the url fallback carries no PAT), so `git push --dry-run` returned `could not read Username`. **This is a fact about THIS cloud session only.** Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl` — **commit these output files (ledger, metrics, this handoff) as usual.** DB migrations and artifact repairs do not go through git and were fully available; nothing was clearly-safe-and-needed to ship.

**Run:** `rpc-nightly-autonomous-pass`, cloud, 2026-08-26 ~01:03–01:10 PT (08:03–08:10Z).
**Mode:** genuine overnight (DB `now()` 01:03 PT, inside 00:00–06:00), NO-PUSH.
**Outcome:** **nothing shipped — a quiet, honest night.** Security clean, last night's ships verified, everything else already-shipped / operator-gated / off-limits.

---

## Reviewed
- **Drained the inbox** (244 files total; per policy filings are permanent citation targets and are NOT archived). Read every candidate filed since the last pass (08-25 08:16Z): ccm-step2, golazos scheduler-skip (refuted), daytime saturation symptom, allday promote leg, Sentry-dark day-7, golazos pg_net (self-retracted), weekly-db-maintenance/24h-floor, candy-listings-indexer 300s, cron-reschedule exit condition, atlas-proxy RPC blocker, git-gotcha, scratch-table.
- **Health baseline:** `rpc_ops_snapshot()` (ran clean, no spell — io_wait 0), Sentry (`search_issues`), Vercel runtime errors (`get_runtime_errors`, 24h), security invariants (all via snapshot), scratch-table re-stat.
- **Artifacts:** listed 11, none flagged broken/stale, none updated since 08-16, fresh-on-open → no drift, no repair.

## Health-drift findings
- **Security: fully clean** — `invariants`, `anon_write_holes`, `rls_off_base_tables`, `secdef_anon_violations` all `[]`.
- **Trust health: 2 breaches, both known/noisy.**
  - `public_board_slow_count` = 5 (breach_at 1). Corroborated by Vercel: 6 `[candy-mlb] candy_*_board … canceling statement due to statement timeout` groups, timestamps minutes old. Known IO-saturation class on the public `/insights/candy-mlb` boards.
  - `unmapped_resolution_backlog_max` = 348 (breach_at 100). Standing AllDay residual (47,183 actionable, net-draining ~-39/24h). Known-structural.
  - `trust_precompute_max_age_hours` = 5.31 (fresh) → these breaches are REAL, not a refresher-rollback artifact.
- **Sentry: STILL DARK, ~8 days.** 0 unresolved in 48h/7d vs **50 live Vercel error groups**. Dark-reporter discriminator fires. Operator-gated.
- **Vercel:** 50 runtime error groups/24h, all saturation-class (candy board timeouts, wallet-backfill connection-pool timeouts, 300s cron kills, 45s edition/player/pack RPC timeouts degrading honestly to empty). No new non-saturation class.
- **Deltas vs last metrics (`nightly-20260825T0804Z`):** editions total 27,249 → 27,257 (+8; TS 19,841→19,849). db_size 13,918 → 13,953 MB. FMV HIGH+MED: TS 7,631 · AllDay 1,579 · Golazos 2 · UFC 0 (last run's snapshot FMV leg had timed out, so no clean prior comparison). trust breaches 4→5 slow-count, 350→348 backlog — flat/within noise.

## Post-ship watch (last night's ships) — PASS
- ✅ **ccm-step2 `SET LOCAL enable_nestloop = off`** (migration `20260825170000`, Claude Code). pg_cron **jobid 4 succeeded 2026-08-25 23:25:09Z in 9.5s — first success since 08-17.** Diagnosis (planner underestimates the 72%-of-partition cohort join by 2.05×, picks a nested loop) holds. **Do not revert.** Target metric to keep watching: jobid 4 nightly at 23:25Z stays `succeeded` and `cross_collection_ts_set_overlap_mat.computed_at` stays fresh.
- ✅ **pipeline-health 24h-floor fix** (`4fb977b9`). On origin/main, no regression. Watch: `weekly-wmc-prune` and other long-cadence entries no longer read RED between runs.

## Shipped
None.

## Queued — needs Trevor / Claude Code (all off-limits or operator-gated for a cloud NO-PUSH pass)
1. **Sentry dark ~8d** — from a box with egress: Sentry → Stats/Usage (accepted vs dropped since 08-18), or POST one envelope to the ingest endpoint and read the status (429+`X-Sentry-Rate-Limits` = quota, 202 = app not sending). Then the bounded `beforeSend` sampling. Also blocks the two-client-init consolidation (wants a live Sentry to verify against).
2. **candy-listings-indexer** — 73% of ticks killed at the 300s `maxDuration` wall (heartbeat present, no terminal row; `pipeline_runs` shows a false 100% success). Fix = chunk/cursor the Magic Eden listing walk **without** breaking the route's "complete-sweep-or-abort" invariant (a naive chunk would start deactivating live asks). Ingest logic — off-limits.
3. **compute-laliga-pack-ev** — PGRST002 schema-cache collision (`rpcWithRetry` only covers ~250ms of a 20s outage) **plus** a 508s > 300s budget overrun. Two distinct failures. Pack-EV/ingest logic — off-limits.
4. **topshot-active-listings-ingest** — the red workflow's real blocker is **not** egress: `topshot_serial_board_candidates()` calls `serial_fmv_estimate` **2×/edition for every HIGH/MEDIUM TopShot edition (~26k calls) before the $100 floor prunes**. atlas-proxy fixes only ~9 of 40 fails; 29+ die earlier here. Fix = defer the 2nd call via LATERAL after the floor, or a cheap `fmv_usd` pre-filter — **prove equivalence over the full population first** and compare buffers. FMV route logic — off-limits.
5. **Worker-slot starvation** (`max_worker_processes`=6 vs `cron.max_running_jobs`=32) — the `job startup timeout` class hitting weekly-db-maintenance et al. Platform-capacity decision.
6. **Additive `hours_since_last_completion` monitoring arm** — read-only instrument to catch heartbeat-without-terminal kills (predicate designed in inbox `2026-08-26T0400Z`; the healthy population sits ≤0.8h, unhealthy ≥20h — clean separation). Queued rather than shipping an orphan instrument nothing consumes; ship alongside a consumer/alert.
7. **cron-reschedule (`2f2736c5`) exit-condition** — first ticks under the new schedules are 09:54–09:56Z (after this run). Read a `job startup timeout` as a **falsifier**; silence proves ~33% little (not the "gone quiet" clearance originally stated). Corrected reading in inbox `2026-08-26T0525Z`.
8. **git-gotcha doc** — a stale `.git/index.lock` makes `git merge` print `Updating X..Y` while HEAD never moves; verify merges by re-reading HEAD, not the printed line. Append to `docs/reference/tooling-gotchas.md` (docs; needs push).
9. **#22** — defeated credential-purge branch `claude/todo-implementation-e4tib3` still carries the pre-purge blob (triage `ee94c8a2a` → GitHub-UI delete → GC → rotate regardless).

## Failed / blocked / reverted
None. No verification failures, no hard-stop. Push unavailable (expected for a cloud session) — outputs written to the mount, uncommitted, to be committed from Trevor's box.

## Notes
- Scratch table `_rpc_waste_baseline_20260825` (08-25 "filed not fixed") was **already secured** by its owning session (RLS on, anon/auth SELECT false, still being written — 21 rows, last 07:03Z). Re-stat-before-acting avoided a redundant no-op DDL on a live table.
- Inbox archived nothing (per the do-not-archive policy, refuted 2026-08-24 `3e2d90ac`).
- Lock released on the mount.
