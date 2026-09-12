# RPC overnight pass — 2026-09-12 (01:03–01:3x PT)

> ⚠ **SCOPE OF THE NO-PUSH BLOCKER — read before acting.** This session ran on Trevor's desktop but **bash/git were entirely dead** — the Sept-8 Windows update broke the Plan9/virtiofs mount the sandbox shell needs (`Plan9 share "c" which is not mounted`), 4th night in a row. So NO git this run: no clone, no fetch, no commit, no push. **The file tools (Read/Write/Edit) reach the mount fine**, and **Supabase / Vercel / Sentry / Cowork-artifact MCP were all live**, so DB reads + this handoff + ledger + metrics were done normally and written to the mount. **These three output files are UNCOMMITTED on the mount.** Trevor / Claude Code: `git add` + commit them as usual, then run the three ledger guards. This blocker is about *this desktop session's shell*, not the artifacts — everything below is real.

**Mode:** NO-PUSH (shell dead) · genuine overnight window (01:03 PT, confirmed from DB `now()`, not the prompt clock) · lock taken (was RELEASED by the 09-11 cloud pass) · no FREEZE.

**Verdict: QUIET / QUEUE-ONLY NIGHT. Nothing shipped.** Nothing on the candidate list was both clearly-safe and net-positive to ship autonomously: the two acute items' real fixes are behavioral changes on user-facing paths (Trevor's call), and the instance was in live IO contention — a bad time for index builds or any migration (schema-cache 500 burst). Post-ship watch on the 09-11 ships: healthy.

---

## 1. Post-ship watch (09-11 ships by Claude Code)

- ✅ **Pinnacle metadata-backfill "discovery is complete and cursored"** (ledger 09-11) — **tracking exactly as its re-check condition predicted.** The new `extra` fields went live ~05:22Z (09-11 22:22 PT); since then `q4_targets_total` **7 → 6** (completeness predicate resolving targets), `disagreements_corrected` 1 then 0, `q4_unknown_name_chain_written`=3 (the published exclusion). `q3_wrapped` still false — expected within ~17 ticks, only ~2 ticks on new code so far. No regression. **Keep watching** `q3_wrapped` flips true at least once and `q4_targets_total` keeps falling.
- ⚠ **offers-sweep disable (09-11 backstop step commented out) — NOT yet effective.** `offers-sweep` still ran 3×/12h, last **02:31Z**, 3/3 failing against the decommissioned host, in the same timestamp cluster as `allday-listings-indexer` (02:31Z) → the GHA `dead-lane-backstop.yml` is **still reviving it**. That disable is a workflow-code change (push-gated). **Desktop: confirm the 09-11 disable commit actually reached `origin/main` and the workflow redeployed.** Impact is trivial (6 failing no-op invocations/day, no data loss), but the ledger records it as fixed and it is not yet.
- ✅ **Q1 board-MV perf regression (09-11 queued) appears RESOLVED.** Last night `rpc_ops_snapshot()` timed out inside `board_mv_refresh_max_stale_hours()`; tonight it **completed cleanly** and `board_mv_refresh_stale_hours`=1.94 (ok). Either the fix landed or it self-healed. Confirm the Q1 migration is actually applied+committed (don't assume from the green read alone).

## 2. Health sweep (01:04 PT / 08:04Z)

- **Security: 4/4 clean** — invariants [], anon_write_holes [], rls_off_base [], secdef_anon [].
- **Trust health: 1 BREACH** — `topshot_impossible_parallel_serials` = **5** (breach_at 3; was 4 on the 20:09 PT monitor tick). **Known #82** — the `raise_impossible_parallel_circ()` self-heal is a structural no-op (see inbox `2026-09-11T0927Z…self-heal-is-a-structural-no-op`); fix is behavioral, tracked, not tonight. All other 38 arms ok and fresh (`trust_precompute_max_age_hours`=5.27).
- 🔴 **Live saturation / M11 still unmet (3rd+ day).** `cron.job_run_details` `job startup timeout`: **261 in 24h, 15 in the last 30 min, 14 distinct spell-hours in 72h** across ~29 pg_cron jobs. These write **no `pipeline_runs` row**, so every pipeline monitor reads them as silence. Bar is 0-in-7-days. At sweep time: 6 active backends, 6 IO waiters, 0 WAL waiters (IO-busy, not a full cascade this minute).
- **Chronic timeout-under-load lanes** (saturation collateral, tracked): fmv-backfill 66.7%, sales-counterparty-backfill 47% (see Q-SCB), price-snapshots 33%, run-insider-detectors 28%.
- **Silent lanes:** allday-listings-indexer (invoked_but_never_logged, 333 min), snapshot-pack-asks + golazos-listings-indexer (cron_silent ~43 min — cron-job.org cadence / slow GHA floor, known). snapshot-institutional-wallets silent ~41h → Q-INST.
- **Edge-fn 403/400 arms** (atlas-editions, atlas-market, flow-rest-moment-moved): all `info`, self-attributed, benign by design. Freshness intact (last ok drains ~08:03Z).
- **Artifacts:** 11 enumerated, none flagged broken; flagship `rpc-live-health` payload validated clean by the 20:09 PT monitor. No schema change tonight → none repaired.
- **DB size 28,343 MB**, up ~1,547 MB from the 09-11 pass (26,796 MB). Atlas-events + `cron.job_run_details` have no retention — ongoing growth, see needs-Trevor.

## 3. Queued (not shippable autonomously this run)

**Q-355 — jobid 355 `rpc-backfill-pinnacle-trade-acquisitions` is the named culprit of the acute spells; the real fix is Trevor's one-line call.** Deep measurement in a genuine quiet window (inbox `2026-09-12T0115Z…settles-jobid-355`) **refuted both cheap fixes**: cutting the 50,000 batch is a no-op (LIMIT non-binding, estimate rows=19, byte-identical plan at 50), and expression indexes are not needed (the existing `idx_wmc_moment_collection_cover` already drives a nested loop at ≤14 days). The job re-derives a **complete** set every run (3,728 candidates vs 3,742 existing; 3 rows inserted in 24h) — cost is cache-residency variance, 8 s warm vs 490 s cold, and the cold runs saturate disk IO.
  - **Fix (ready, Trevor-gated):** add `WHERE t.traded_at > now() - interval '14 days'` to the `candidates` CTE of `backfill_pinnacle_trade_acquisitions` → 108× fewer reads at 7d, 16× at 14d (14d chosen for a 12.7× safety margin over the observed 1.1-day steady-state lag).
  - **Why not autonomous:** it changes what the system CAPTURES on a user-facing path — `moment_acquisitions` feeds `/api/cost-basis`, `/api/wallet-cost-basis`, `/api/wallet-hold-time`, `/api/wallet-search`. A trade whose cache row lands >14 days late is skipped permanently. Observed window is only ~12 days of steady state. **Revert = drop the WHERE; a one-off unbounded manual run re-catches anything ever missed.**
  - ⛔ Do **not** cut the batch (refuted). ⚠ An even-safer interim Trevor could pick instead: reduce jobid 355's cadence (`23 1-22/3` = 8×/day) — fewer expensive re-derivations, **no** capture loss — but I did not ship it either, because it is a (smaller) freshness tradeoff on the same user-facing path and the authoritative filing left that class to Trevor.

**Q-SCB — `sales-counterparty-backfill` is permanently exhausted and rescans both `sales` partitions 286×/day to return zero** (inbox `2026-09-12T0117Z…`). 195,564 buffers touched to deliver 0 rows (221,183 rows read then post-`Filter`-discarded), 4.3 s warm, 47% timeout under load. The cursor is pinned at 2024-04-19 and cannot advance (only advances on claims; none occur). Remaining rows are studio-history, ineligible by design.
  - **Durable fix (behavioral → Trevor/Claude Code):** give the lane a terminal/exhausted state so a drained backfill stops (or drops to a weekly probe) instead of re-deriving the same zero forever.
  - **Secondary (additive index, quiet-window only):** add `source NOT IN ('allday_studio_history_v1','ufc_studio_history_v1')` to the `…_nullseller_soldat` partial-index predicate — evidenced by the 221,183 `Rows Removed by Filter`. **Not built tonight:** the filer deprioritizes index-alone ("makes the waste cheap and permanent, not correct"), an index build is heavy IO, and the instance was IO-contended at run time. ⚠ EXPLAIN-confirm adoption before building.

**Q-INST — `snapshot-institutional-wallets` missed its 09-11 daily tick (silent ~41h).** Daily cron-job.org job, last ok 09-10 10:07Z (3 rows). Low data impact; a skipped scheduled day is a cron-console health signal. **Check the cron-job.org entry is enabled/scheduled; confirm the 09-12 10:07Z tick lands.** (Console access is push-independent but Chrome-driven; not attempted this run.)

**Q-MTP — `match-topshot-players` weekly full run failed on `upstream request timeout`** (09-11 08:00Z, 0 rows). This is the exact tick ledger #54 recorded as owed. Gated to weekly → will not self-retry until ~09-18. Re-trigger (upstream timeouts are transient) or accept a 1-week player-name-match gap.

**Q-PACKREALITY — `topshot_pack_reality_top_ev` board = 0 rows → assessed LEGITIMATE-EMPTY, low priority.** Source `pack_distributions` is fresh (max updated 06:17Z, 2,149 rows/7d — the "9d stale" alert is the known benign `updated_at`-not-freshness signal), and the refresh MV job is healthy. So the empty is "no packs currently clear the top-EV bar," not a starved feed. Residual: does the public `/insights/pack-reality` route render 0 as an honest empty vs a false "no +EV packs" conclusion — a route (.tsx) read + possible handoff, push-gated, deferred.

## 4. Needs Trevor (carried forward)

- **`cron.job_run_details` retention** — no retention; it is the root cause of the (now-resolved-symptom) board-MV perf regression and a standing DB-growth contributor. Destructive → operator.
- **Atlas-events retention** — DB +1.5 GB/24h, no retention.
- **#55** — both 2-hourly Routines still `enabled:false`, no approval card.
- **#22** — credential-purge residue: ask GitHub to GC the unreachable blob; rotate regardless.
- **Inbox archival** — 435 un-archived files (mostly August), un-archivable no-push; needs a push-capable desktop/Claude-Code pass. I deliberately did **not** churn the inbox via file tools (uncommitted moves would diverge mount from origin and confuse the next pass).

## 5. Failed / reverted

None. No production changes made this run.
