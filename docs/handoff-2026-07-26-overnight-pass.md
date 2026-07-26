# Overnight autonomous pass — 2026-07-26

**Mode:** GENUINE OVERNIGHT. Fired 08:03Z / **01:03 PDT** (INSIDE 00:00–06:00). No clock skew (shell 08:02:50Z ≈ DB `now()` 08:03:03Z ≈ max sale ingested 07:56Z ≈ max FMV 07:54Z — production rows can't be future-stamped so real time is confirmed). Push AVAILABLE (`git push --dry-run` = up-to-date), no FREEZE, lock taken over (previous run RELEASED). Full tooling live: Supabase + Vercel + Sentry MCP, bash/git/clone/push, Cowork `list_artifacts`.

**Result:** Shipped **1** (DB-only pg_cron stagger, subagent PASS 4/4), reverted 0, repaired 0, closed 0. Drained 1 inbox file (`2026-07-25T160927Z.md` -> archive). Budget used 1/4.

- `origin/main` **`d752f9ea` unchanged start->end** — a large interactive session (Trevor + Claude Code) landed ~25 commits the prior evening (newest 04:59Z ~= 21:59 PDT, ~3h before this run: fee table + fee-net sniper, entity-section fetch policy, Pinnacle serial-FMV wallet parity, pinnacle-wallet un-gate, a 6-batch test-coverage program) but nothing pushed during the run. Prod deploy `d752f9ea` (dpl_5MqC5zNQeNmPbFGeyq8PT1CWcCcP) READY, 0 ERROR-state (all CANCELED deploys in the window are docs-only commits correctly skipped by `ignoreCommand`).

---

## Shipped

### `audit_20260726_stagger_pgcron_pack_backfill_convergence` (DB-only, no deploy)

Breaks the sub-5-minute pg_cron worker-startup convergence pileup the 07-25 16:09Z daytime monitor flagged (candidate #1, MED). Eight high-frequency pack/mint backfill+refresh jobs converge on the same minutes; at **:54 six of them fired together** (jobids 84 `*/2`, 25 `*/3`, 29 `*/3`, 27 `2-58/4`, 83, 56), exceeding pg_cron's background-worker startup capacity and producing a self-recovered `pgcron-startup-timeout` HIGH alert + a 441-run pool burst in the 15:40–15:56Z window on 07-25. With the 07-25 pager arm this convergence emits **HIGH** every window -> alarm-fatigue risk for Trevor.

**Fix** — three schedule-only phase shifts, in-place by jobid via `cron.alter_job` (preserves owner=`postgres`, command, cadence/frequency; only *when* they fire changes, never *what* they do):
- **29** `rpc-topshot-pack-sales-backfill`: `*/3` -> `1-58/3` (phase-shift the `*/3` twin off the identical 25 `*/3` twin — the highest-leverage move; 25+29 always fired together)
- **83** `rpc-pinnacle-mints-forward`: `4,14,24,34,44,54` -> `6,16,26,36,46,56` (off the :54/:24 pileup)
- **56** `rpc-topshot-pack-opens-history`: `9,24,39,54` -> `11,26,41,56` (off the :54/:24 pileup)

**Verification (independent subagent, PASS 4/4):**
1. All 3 jobs carry the new schedules, `username=postgres`, `active=true`, non-empty `net.http_get` command (owner+command preserved).
2. The other five flagged jobs (84/25/27/16/73) are byte-identical unchanged.
3. Independent per-minute concurrency computation over the 8 jobs: **old max = 6 @ :54 -> new max = 4** (<=4 target met; the residual 4-way overlaps all include the unavoidable `*/2` pinnacle-mints-backfill and are well within worker capacity — the incident needed 6+ *and* a pool burst). Simulation reproduced by the subagent from first principles, not the pass's numbers.
4. `check_pgcron_recent_failures()` = `[]`.

- **Revert:** `SELECT cron.alter_job(job_id:=29, schedule:='*/3 * * * *'); SELECT cron.alter_job(job_id:=83, schedule:='4,14,24,34,44,54 * * * *'); SELECT cron.alter_job(job_id:=56, schedule:='9,24,39,54 * * * *');`
- **Target metric (re-check tomorrow):** no `pgcron-startup-timeout` HIGH in `get_pipeline_alerts()` during the :54/:24 windows; `check_pgcron_recent_failures()` stays `[]`; the 3 jobs keep firing ok at their new minutes with unchanged runs/hour.

---

## Health-drift triage (baseline `rpc_ops_snapshot()` @ 08:04Z)

GREEN. security **0/0/0/0** (invariants/anon_write_holes/rls_off_base/secdef_anon all `[]`); trust **20 metrics, 0 breaches**; `stalled_pipelines` `[]`; `check_pgcron_recent_failures()` `[]`; sentinel_ts_uuid_editions_48h **0**; Sentry **0 unresolved production issues / 24h**; Vercel prod `d752f9ea` READY 0 ERROR.

Deltas vs 07-25 metrics-latest:
- DB **10,779 -> 11,109 MB** (+330/~24h, normal churn).
- FMV TS HIGH+MED **2,957 -> 2,807** (-150; documented oscillation band, TS FMV fresh 0.3h, sanity 0).
- editions unchanged (TS 19,513 / AllDay 6,190 / Golazos 575 / UFC 518 / candy_mlb 125).
- unmapped_resolution_backlog_max 31 -> 46 (well under breach 100).
- topshot_impossible_parallel_serials 0; fmv_sanity_flags 0; edition_integrity_flags 5 (< breach 50).

**Pipeline alerts (2):**
- **HIGH `unmapped-sales-nfl_all_day`** — 45,554 open, inflow 4,626/24h vs outflow 1,037/24h (drain 0.22, net +3,589/day), oldest open 2026-02-04. **KNOWN CARRIED** — already logged in the 07-25 ledger + weekly sweep; the 16:09Z monitor explicitly declined to re-raise it. Fix is AllDay unmapped-resolver *throughput* (ingest/resolver route-logic = off-limits/invisible-failure class). QUEUED, not shipped.
- **info `ufc_sales` resolving_editions** — standing, 15 events/24h, edition-resolution bridge pending. Not actionable.

**pipeline_fails_24h** — all known/self-recovering: `wallet-backfill` 24 / `-allday` 22 / `-pinnacle` 14 / `-ufc` 5 (contention), `sales-seller-recovery-dune` 23 + `sales-ingest-dune` 11 (DUNE-DATAPOINT-CAP-402, cursors parked), `sales-counterparty-backfill` 15, `compute-topshot-pack-ev` 12, `pinnacle-nft-resolver` 11 (productively draining), `allday-lock-refresh` 8, `wallet-username-resolver` 7. None stalled, none newly regressing.

**Post-ship regression watch — the 07-25/26 wave: ALL PASS, 0 reverts.**
- 07-25 night ship `audit_20260725_get_team_activity_soldat_ordered_rewrite` (28s->~60ms): no team/player pool-timeout Sentry issues in the last 24h (NEXTJS-20/-1Y last fired 07-24 before the retry fix; 0 since). Health-green corroborates.
- Daytime 07-26 wave (fee table + fee-net sniper, entity-section fetch policy on all 5 entity routes, Pinnacle serial-FMV wallet parity, `/api/pinnacle-wallet` un-gate, `idx_editions_collection_team_slug`, 6-batch test-coverage): all deploys READY, security `[]`x4 after the whole DDL wave (incl. the two new `serial_fmv_estimate` overloads whose stray PUBLIC/anon grants were already revoked -> `secdef_anon_violations` `[]`), Sentry 0 new/24h. No regression attributable -> no auto-revert warranted.

**Artifacts:** 15 listed. rpc-live-health validated by the 16:09Z monitor (all boards + pinnacle_fmv + listings/unmapped legs resolve, no schema drift); none flagged broken; tonight's schedule change has no effect on any artifact's data shape. None repaired.

---

## Queued (not shipped — with reason)

- **SET-DETAIL-PAGE-POOL-RETRY-GAP** (LOW, code) — inbox #2. `app/(collections)/[collection]/set/[slug]/page.tsx`'s primary RPC read (`get_set_detail`) lacks the `rpcWithRetry` wrapper the player/team/pack/edition detail pages already got (Sentry `JAVASCRIPT-NEXTJS-22`, 1 event ~15:48Z during the 07-25 saturation spike). **NOT auto-shipped: the file was committed `d752f9ea` ~3h before this run — inside the 48h hot-file window.** Ready fix: wrap the `get_set_detail` read in `lib/analytics/rpc-with-retry.ts` `rpcWithRetry` (3 attempts, backoff) exactly as the entity-section pass did for player/team, + a regression test; verify the page is actually unwrapped first. Fold into the next entity-section-policy continuation (that pass explicitly left edition/set/series decorative fetchers and this is the same family).
- **ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH** (HIGH alert, carried) — 45,554 open, net +3,589/day. Real lever is AllDay unmapped-resolver throughput (ingest route-logic = off-limits). Tracked in the 07-25 ledger + weekly sweep; carried, not re-raised as new.
- **Standing carried queue (unchanged):** REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST, CORRELATED-PIPELINE-DROPOUT-DETECTOR, PIPELINE-WATCHLIST-COVERAGE-AUDIT, DUNE-DATAPOINT-CAP-402 (operator/billing), TOPSHOT-BADGE-CATALOG-429, WMC-PRUNE-120S-CEILING, LIVE-HEALTH-ARTIFACT-DEAD-TABLE-CREDIT, COMPUTE-LALIGA-PACK-EV-ALGO-VERSION-SCHEMA-MISMATCH, NON-WAVE-WALLET-BACKFILL-DRIVER, WMC-LOCK-FRESHNESS, MARKET-EDITION-LINK, CLAUDE-MD-GOLAZOS-LOW-ASK-STALE, Panini go-live (Trevor editorial), chain-two/Candy (gated).

**Optional owner action for the convergence class:** if the residual 4-way overlaps (all including `*/2` pinnacle-mints-backfill) ever still trip the worker ceiling, the durable fix is raising pg_cron `max_worker_processes`, or tuning the `pgcron-startup-timeout` pager threshold — both owner calls, not autonomous.

---

## Failed / blocked / reverted

None. No verification failure; production shipping was not hard-stopped.
