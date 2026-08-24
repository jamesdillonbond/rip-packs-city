# RPC overnight pass — 2026-07-17 (OFF-HOURS / MONITOR-MODE)

**Mode:** OFF-HOURS monitor-mode. Fired ~06:41 PDT (shell `date -u` 13:41:39Z), OUTSIDE the 00:00–06:00 window → full triage + post-ship watch, **queue instead of ship, docs-only**. Auto-reverts of regressions still permitted (none needed).

**Clock skew:** NONE. shell 13:41:39Z ≈ DB `now()` 13:41:54Z ≈ newest sale 13:32Z ≈ newest fmv 13:38Z (all within seconds). Real local time ~06:41 PDT confirmed against DB/app clocks.

**Gates:** lock was RELEASED (07-16 marker) → took over. No FREEZE. Push AVAILABLE (`git push --dry-run` → up-to-date). Inbox EMPTY (no monitor files to drain).

**Concurrency note:** Trevor is **actively pushing to `main` during this run** — `7c701ea0` "feat(candy): drop-day discovery script + Jul 17 runbook" was BUILDING at run time (Candy MLB Drop 1 is confirmed for today, Jul 17, 10 AM PT). This is expected/sanctioned prep, not a collision. Monitor-mode already ships 0, so the only effect is a rebase-before-push on this run's docs commit.

- origin/main at fetch: `c28a8c5a` (cadence-escrow-tests promoted to blocking gate). Prod code HEAD `c28a8c5a` READY (`dpl_7GyFMKd8Dss5W5UU77tFzoHm8D9j`).
- Shipped **0**, reverted 0, repaired 0, closed 0. Docs-only outputs (this handoff + ledger + metrics + CLAUDE.md entry).

---

## What was reviewed

- **Continuity:** CLAUDE.md (current to 2026-07-17), ledger (full — 2,613 lines, current through today's CC day), focus.md (2026-06-24 steer + standing pg_cron check), last handoffs, metrics-latest.json (07-16 overnight baseline).
- **Inbox:** EMPTY in both clone and mount — no daytime-monitor candidate files since the last night pass. Nothing to drain/archive.
- **Health baseline:** `rpc_ops_snapshot()` full vector + `check_pgcron_recent_failures()` + targeted `pipeline_runs` drill-downs + Sentry + Vercel.
- **Artifacts:** 16 enumerated via `list_artifacts`; none flagged broken/stale in the (empty) inbox; artifacts are fresh-on-open so none regenerated. No repair needed.

**Context — today's 07-17 CC interactive day already closed most of last night's carried queue:** impossible-parallel wave-4 (`8b8602a2`, breach 7/3→0), ATLAS-BLOCK (recovered) + ALLDAY-UNMAPPED (self-drained, premise disproven) closed (`9d63efab`), `analytics_sales_summary` single-scan rewrite (`audit_20260717...`), plus the RPCTradeEscrow Cadence suite (16/16, wired + promoted to a blocking CI gate) and Pinnacle grain-migration Phase 1. This monitor run's job was to independently post-ship-watch that wave and confirm health.

---

## Health-drift findings + deltas (vs 07-16 metrics-latest baseline)

**GREEN across the board. 0 trust breaches, security 0/0/0/0, stalled_pipelines [], pg_cron failures [].**

| Metric | 07-16 baseline | 07-17 this run | Note |
|---|---|---|---|
| security (inv/anon-write/rls-off/secdef-anon) | 0/0/0/0 | **0/0/0/0** | clean |
| trust_health breaches | 1 (impossible_parallel 16/3) | **0** | CC cleared wave-4 (`8b8602a2`) → impossible_parallel now 1/3 ok |
| stalled_pipelines | [] | **[]** | none |
| pg_cron recent failures | [] | **[]** | clean |
| sentinel TS-UUID 48h | 39 | **39** | inert fossils + `::` growth, < breach 200, no leak |
| editions TS / AllDay / Golazos / UFC | 19,420 / 6,190 / 575 / 518 | **19,425 / 6,190 / 575 / 518** | +5 TS `::`, flat elsewhere |
| FMV TS H+M / AllDay H+M | 5,238 / 828 | **5,237 / 826** | flat (churn) |
| unmapped_resolution_backlog_max | 29 | **25** | improving |
| DB size | 9,127 MB | **9,645 MB** | +518/29h — normal `::`/fossil + studio backfill churn; under 07-13 ~11GB peak |
| Sentry new/24h | 0 | **0** | clean |
| Vercel prod | 48991fc4 READY | **c28a8c5a READY** | + Trevor's 7c701ea0 candy drop-day BUILDING (expected) |

**pipeline_alerts (2, both benign/known):** `golazos_sales` resolving_editions INFO (1/24h), `ufc_sales` resolving_editions INFO (42/24h). PINNACLE-SALES-BACKFILL-SPORK-FLOOR no longer alerting (suppressed 07-16).

**pipeline_fails_24h — all known overnight-contention family, none stalled:** lock-check-batch 18, analytics-smoke 9, wallet-username-resolver 8, fmv-recalc 8, compute-topshot-pack-ev 6, pinnacle-nft-resolver 4. `stalled_pipelines [] ` confirms none silently stalled; each recovers on the next tick.

---

## Post-ship regression watch — ALL PASS, 0 reverts

Re-measured every prod-affecting change shipped in the last ~24–48h against its target metric:

1. **CC 07-16 `get_lock_check_batch` index-driven rewrite** (the #1 disk reader, 1,522 MB/193s → 8.4 MB/119ms). **PASS.** lock-check-batch **statement-timeout** failures went 3 (07-16) → **0** (07-17) — the read-IOPS hog is eliminated. (The residual lock-check-batch failures are a *different* class — see the new finding below.)
2. **CC 07-16 `raise_edition_offers_from_chain()` statement_timeout=600s** (offers-raise backstop, pg_cron jobid 48). **PASS.** `check_pgcron_recent_failures()` = [].
3. **CC 07-17 `analytics_sales_summary` single-scan rewrite** (migration `20260717030556`, #1 pg_stat_statements reader, 4 base scans → 2, byte-identical). **PASS — strong.** analytics-smoke `ok=false` went **14 (07-16) → 0 (07-17)** (all 07-17 runs ok, latest 13:43Z ok). Migration confirmed live.
4. **CC 07-17 `8b8602a2` impossible-parallel wave-4 circ floor-raise** (migration `20260716235650`). **PASS.** `topshot_impossible_parallel_serials` 16 → **1** (ok), trust health 16/16.
5. **fmv-recalc** — normal overnight-contention (3 fails 07-17, 49 ok, latest 13:28Z ok), not stalled. No regression.
6. **Sentry** — 0 new unresolved issues/24h in production. No new error class traceable to any ship.

Security invariants 0/0/0/0 after the full 07-17 DDL wave (independently re-confirmed by CC's own health sweep + this run).

---

## NEW finding queued (LOW / watch)

**LOCK-CHECK-BATCH-DEADLOCK-UPTICK (LOW, watch).** Separate from the read-IOPS class CC's `get_lock_check_batch` rewrite fixed. Over 72h, lock-check-batch failures shifted from statement-timeout (07-15/16) to **deadlock + lock-timeout on 07-17** (2 deadlock + 5 lock-timeout in the 07-17 window). This is **write-contention on the `wallet_moments_cache` UPDATE** the pipeline performs after reading the batch — competing with other wmc writers (wmc-fmv-populate, rwfd, image denorm). It is **NOT a regression from the rewrite** (lock-timeouts were present 07-14 too, 2 of them; the rewrite only changed the READ path) and it is **self-recovering** — 21 ok runs on 07-17, the latest run (13:38Z) ok, and `detect_stalled_pipelines()` [] (never silently stalls).
- **Why not auto-shipped:** the correct fix is route-logic (lock-ordering / SKIP LOCKED / retry-with-backoff) on the lock-check-batch pipeline, which touches an ingest-adjacent write path — the repo's off-limits/invisible-failure class — and it's a real fix, not an additive index. Off-hours monitor-mode ships 0 regardless.
- **Watch:** if the deadlock rate climbs across multiple days or the pipeline begins to stall (leaving wmc lock_checked_at stale), it graduates to a CC route fix. Today it's self-clearing noise.
- **Ready lever (CC, not blind):** add `FOR UPDATE SKIP LOCKED` to the batch's row-lock claim (or a bounded retry on 40P01/55P03) in the lock-check-batch route so a contended row is skipped rather than deadlocking.

---

## Carried queued (unchanged, all owned — no night-count bump; today's CC day is the active owner)

- **V-MOMENTS-NEEDING-HYDRATION** (IOPS owners) — `v_moments_needing_hydration` full anti-join, 89.6%-selectivity seq scan on `moment_acquisitions`; an index can't fix it (reading 90% of rows is cheaper sequentially), needs an incrementally-maintained/materialized "needs hydration" set with correctness risk. CC assessed + deferred 07-17.
- **PINNACLE-SALES-BACKFILL-SPORK-FLOOR** (CC/operator) — false-severity; cursor parked at spork floor 137390146, forward pinnacle ingest healthy; alert suppressed 07-16.
- **PINNACLE-GRAIN-MIGRATION Phase 2+** (Trevor/CC) — ASK-unify runbook is ready + verified (independent of the blocker); the 2 remaining `pinnacle_editions` reads are character-lossy (legacy `edition_key` is per-set-pack, not per-character) → data-architecture call, not a mechanical repoint.
- **Standing operator/gated queue:** ownership-sync-dune weekly retrigger, home-machine Task Scheduler ingests, `topshot-moments-hydrator` GetMintedMoment upstream errors, allday-pack-opens-404 (sub-spork-floor, unreachable), cron-job.org trigger-dropout family (self-healing), BUYERBF, TS art-less self-heal tail, DISK-IOPS-throttle watch, chain-two/Candy (gated — **Candy MLB Drop 1 confirmed today Jul 17 10 AM PT**; Helius gate CLOSED 07-16; Item-0 discovery is the drop-day play).

---

## Failed / blocked / reverted

None. No shipping attempted (off-hours monitor-mode), nothing errored, nothing rolled back.

---

## Output

- Handoff: this file (`docs/handoff-2026-07-17-overnight-pass.md`).
- Ledger: 2026-07-17 monitor-pass entry prepended; new LOCK-CHECK-BATCH-DEADLOCK-UPTICK queued LOW.
- Metrics: `docs/overnight/metrics-latest.json` overwritten with tonight's vector.
- CLAUDE.md: brief Recent-sessions entry prepended.
- Lock: released on the mount.
