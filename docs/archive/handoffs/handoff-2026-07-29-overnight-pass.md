# RPC overnight pass — 2026-07-29 (OFF-HOURS monitor-mode)

**Fired:** 2026-07-29 23:28Z / **16:28 PDT** — OUTSIDE the ~00:00–06:00 local overnight window, so this run executed in **MONITOR-MODE per the quiet-hours guard**: full review + Section 2 health triage + post-ship watch, **QUEUE everything, ship nothing** (auto-revert of a regression would still be allowed; none was needed).

**Clock-skew check:** no skew. Shell `date -u` 23:28Z ≈ DB `now()` 23:28:49Z ≈ max sale ingested 23:23Z ≈ max fmv computed 23:28Z. Shell time is authoritative; local time is genuinely afternoon, not a skewed overnight.

**Gates:** prior lock was RELEASED (07-28 run) → took over, wrote a fresh lock, RELEASED at end. No `docs/FREEZE.md`. Push AVAILABLE. `origin/main` = `b36cc2c1` at run start; **a concurrent session advanced it to `344e273d` mid-run** (monitor inbox commit + a Claude Code candy TODO-comment fix + its ledger entry) — per the collision gate this run stayed QUEUE-ONLY (already monitor-mode), rebased onto the new tip, and preserved all landed entries. Fresh sandbox clone at `$HOME/rpcwork`, on `main`.

**Shipped:** 0 (off-hours). **Auto-reverted:** 0. **Repaired:** 0. **Inbox drained:** 1 (the monitor's active-listings-dropout candidate — folded into the queue below, archived).

---

## Health-drift findings (Section 2)

Baseline via `rpc_ops_snapshot()` + drill-downs. **GREEN overall.**

- **Security:** `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []` — 0/0/0/0.
- **Trust health:** 23 metrics, **0 breaches**, all `ok`. Notable: `topshot_fmv_pct_stale_30d` 32.3 (breach 50), `ufc_fmv_pct_stale_30d` 96.1 (breach 101 — chronically-thin UFC, by design), `unmapped_resolution_backlog_max` 87 (breach 100 — up from 63 on 07-28, still under), `edition_integrity_flags` 102 (breach 250 — sane post the 07-28 redefinition), `ts_uuid_dupes_created_24h` 6 (breach 200).
- **pg_cron:** `check_pgcron_recent_failures()` = `[]` (clean).
- **Sentry:** 0 unresolved production issues firstSeen in last 48h.
- **Vercel:** prod HEAD READY; last 20 deploys all READY except 2 docs-only commits correctly CANCELED by `ignoreCommand`. 0 ERROR states.
- **DB size:** 11,514 MB (was 11,344 on 07-28; +170, normal).
- **Editions:** top_shot 19,548 (+17), all_day 6,190, golazos 575, ufc 518, candy_mlb 125. `sentinel_ts_uuid_editions_48h` = 6 (was 0; tiny, within normal catalog growth — not a leak).
- **Pipeline fails 24h:** all low/self-recovering — wallet-backfill-allday 6, wallet-backfill 6, wallet-backfill-pinnacle 2, wallet-backfill-multicollection-complete 2, drain-conflated-subeditions 1, topshot-misattrib-drain 1. Net-quieter than 07-28.

### One finding — QUEUED (medium, does not page) — corroborated by the daytime monitor

- **`topshot-active-listings-ingest` (GitHub Actions) scheduler dropout.** `stalled_pipelines` + `pipeline_alerts` flag it `cron_silent`, silent **1337 min (~22.3h)** vs `max_silent_minutes` 900 — exceeding even its own historical max gap (~758 min / 12.6h). Last run 2026-07-29 **01:13Z** (ok=true, 125 rows, ~14-min Atlas sweep); ~7 missed ticks since. **GHA scheduler dropout, not an execution failure** — every run that fires succeeds. **Impact contained:** sibling `topshot-listing-cache` is healthy (every 1–2h, ok=true, ~100 rows/tick through 22:56Z) so live TS listing coverage is intact; active-listings-ingest is the edition-level Atlas full-sweep, severity `medium` = visibility-only (does not page). The underpriced-serials board also has a read-fallback so its surface degrades gracefully. **The daytime monitor independently logged this same finding to the inbox (`d7a4a987`) during this run — corroborated, not a false positive.** The monitor adds a useful detail: runs were firing at **:13**, not the 07-26-staggered **:29** — worth reconciling the live GHA cron string against `topshot-active-listings-ingest.yml` when this is addressed. Not shipped: off-hours + GHA scheduling is not a low-risk DB/doc fix.

## Post-ship watch (last ~24–48h) — ALL PASS, 0 reverts

Last ~24–48h of `main` is **entirely test/docs** (07-28/29 interactive CC test-coverage + DB-pin + PT-date-correction wave, plus tonight's candy TODO-comment fix). Verified:

- All deployed **READY**, 0 ERROR, 0 new Sentry traceable to them.
- The three `20260729000*` "documentation-snapshot" migrations are **explicitly NOT applied to prod** (idempotent live-DDL captures for pinning) → no prod-DB change.
- 07-28 DB ship `audit_20260728_suppress_golazos_offers_cursor_stalled_staged_inert` is **holding** — no `golazos_offers cursor_stalled` alert this run.
- 07-28 `edition_integrity_flags` redefinition reads 102 (sane, ok) — intended, not a regression.
- Tonight's `344e273d` candy TODO-comment fix is comment-only (`candyDiscoveryReady`) — no runtime/prod change.

No shipped change correlates with a regression → no auto-revert warranted.

## Artifacts

11 enumerated via `list_artifacts`, **none flagged broken**, no schema drift this run (no DDL applied) → no repair performed. Two (`candy-chain-two-onboarding-v2`, `rpc-panini-squeeze-v2`) freshly updated 2026-07-29 by the interactive session; fresh-on-open, so working ones not regenerated.

---

## QUEUED — needs Trevor / Claude Code

### New this run
- **GHA-ACTIVE-LISTINGS-INGEST-DROPOUT (night 1)** — `topshot-active-listings-ingest.yml` (GHA cron `29 */3 * * *`) dropped ~7 consecutive ticks (silent ~22.3h, last ok run 01:13Z). Execution healthy when it fires; GitHub Actions scheduler unreliability. Medium/visibility-only; sibling `topshot-listing-cache` keeps live listing data current → no user-facing impact. **Options:** (a) `workflow_dispatch` to confirm the lane still works, then add a temporal backstop trigger (second workflow or a cron-job.org kick guarded by the route's own idempotency); (b) reconcile the live schedule string (observed firing at :13, not the 07-26-staggered :29); (c) widen `max_silent_minutes` if 22h dropouts are tolerated; (d) leave as-is (medium/visibility-only). If it self-recovers on the next tick, close as a normal GHA dropout — do NOT auto-ship a fix. Related to the queued CORRELATED-PIPELINE-DROPOUT-DETECTOR.

### Carried forward (from 07-28 — unchanged, off-limits/gated/hot-file)
- ALLDAY-DECODE-LEG-EFFICACY (resolver route logic = off-limits)
- ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH (info, net-draining; ~26.1d to clear 29,120 actionable rows per `rpc_ops_snapshot`)
- SET-DETAIL-PAGE-POOL-RETRY-GAP (LOW code; hot-file blocked)
- TS-PACK-OPENS-HISTORY-CURSOR-FASTFORWARD (Cowork-queued 07-27; cold-spork 500)
- CANDY-CLASS-PURGE-GUARD-FLOW-CACHES (Cowork-queued 07-27; FMV-feeding, hand-off)
- DUNE-DATAPOINT-CAP-402 (operator/billing)
- TS-PARALLEL-SUBEDITION-CIRCULATION-STRAGGLERS (53 canonical parallels missing circ; ingest domain)
- REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST, CORRELATED-PIPELINE-DROPOUT-DETECTOR, PIPELINE-WATCHLIST-COVERAGE-AUDIT, TOPSHOT-BADGE-CATALOG-429, WMC-PRUNE-120S-CEILING, NON-WAVE-WALLET-BACKFILL-DRIVER, CLAUDE-MD-GOLAZOS-LOW-ASK-STALE
- Panini go-live (`PANINI_PUBLIC`, Trevor editorial); Candy public go-live (`CANDY_MLB_PUBLIC`, gated — Candy ships first)

## Failed / blocked / reverted
None.
