# RPC overnight pass — 2026-07-28

Genuine overnight run, fired 08:02Z / **~01:02 PDT** (inside the 00:00–06:00 window). No clock skew: shell 08:02:07Z ≈ DB `now()` 08:02:35Z ≈ max sale 07:45Z ≈ max fmv 07:54Z. Push AVAILABLE (`git push --dry-run` = up-to-date), no `FREEZE.md`, prior lock RELEASED (took new lock `night-20260728T080302Z`). `origin/main` `9301485` unchanged start→end.

**Outcome:** shipped **1** (DB-only, independently verified), reverted 0, repaired 0, drained 0 inbox files (inbox empty). Health GREEN apart from the one false-positive HIGH this run resolved. A quiet, honest night.

---

## Shipped (1)

### `audit_20260728_suppress_golazos_offers_cursor_stalled_staged_inert` (DB-only, no deploy)

**What:** Silenced a NEW false-positive **HIGH `cursor_stalled`** alert for `golazos_offers` by inserting one row into `public.pipeline_alert_suppression` (the purpose-built suppression table — abundant precedent: `allday_pack_opens_backfill`, `topshot_listings`, `ufc_listings`, `golazos_listings`, etc.).

**Why it was a false positive:** `golazos-offers-indexer` (`app/api/golazos-offers-indexer/route.ts`) is a **staged-inert** pipeline shipped 2026-07-28 as a mirror of the live `allday-offers-indexer` for test coverage/parity. It has **no scheduler** — not in `vercel.json`, no GHA workflow, absent from `docs/operations/cron-schedule.md`. A single one-off manual tick at **2026-07-28 01:01:34Z** (during the interactive session) seeded the `event_cursor` row `golazos_offers` (block 159452130, 0 rows found, ok=true) and it never ran again. `get_pipeline_alerts()`'s `cursor_stalled` arm fires HIGH for **any** `event_cursor` row older than 6h, so this crossed the threshold at ~07:01Z and began paging via `/api/check-alerts` (Telegram+email) with no live-production meaning (no surface consumes Golazos offers; the live offer cursors `topshot_offers`/`allday_offers` are fresh — <18 min).

**Suppression is bounded 30d** (mirrors the `golazos_listings` decision-pending pattern), so it silences the false page now and auto-revisits — if the indexer is scheduled before then its fresh cursor makes the suppression harmless; if still inert at expiry it re-fires for re-evaluation. Reason column documents the full context and says "Remove this row at go-live."

**Verification:** independent subagent PASS 4/4 — (1) suppression row present, reason non-null, `expires_at` = 2026-08-27; (2) `get_pipeline_alerts()` returns 0 `golazos_offers`/`cursor_stalled`/HIGH/critical entries (all 4 remaining are `info`); (3) `golazos_offers` cursor age 7h08m stale while `allday_offers` 3m / `topshot_offers` 18m fresh (live indexers healthy, only the inert one stale); (4) `golazos-offers-indexer` has exactly 1 `pipeline_runs` row, at 01:01:22Z.

**Revert:** `DELETE FROM public.pipeline_alert_suppression WHERE pipeline='golazos_offers';`

**Metric to re-check tomorrow:** `get_pipeline_alerts()` should carry no `golazos_offers` `cursor_stalled` entry; the live `allday_offers`/`topshot_offers` cursors should stay fresh. If `golazos-offers-indexer` gets a scheduler, remove the suppression row.

---

## Health-drift triage

Baseline via `rpc_ops_snapshot()` + `check_pgcron_recent_failures()` + Sentry + Vercel.

- **Security:** 0/0/0/0 — `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`.
- **Trust health:** 23 metrics, **0 breaches**. Note `edition_integrity_flags` = **100** (up from ~5): this is today's **metric redefinition** (`audit_20260728_fix_edition_integrity_flags_metric` — now sums defect columns instead of counting GROUP-BY rows; `breach_at` 50→250), **NOT** a data regression. Still well under 250.
- **Stalled pipelines:** `[]`. **pg_cron failures:** `[]`.
- **Pipeline fails 24h (all known/expected):** `allday-unmapped-resolver` 28 (honest degraded/lock-contention ticks), `sales-ingest-dune` 12 (DUNE-DATAPOINT-CAP-402, cursor parked at 2021-12-30), `wallet-backfill-allday` 5, `topshot-pack-opens-history-backfill` 3 (07-27 cold-spork, reverted + queued), rest single self-recovering ticks.
- **Pipeline alerts:** the golazos_offers HIGH (fixed this run) + all-`info` standing items (`golazos_sales`/`ufc_sales` resolving_editions; `nfl_all_day` unmapped_backlog_growth 27,007 actionable, net-draining ~5.7d; `ufc_strike` unmapped 1,322 frozen-by-design).
- **Sentry:** 0 unresolved production issues firstSeen/24h.
- **Vercel:** prod `9301485` READY; 0 ERROR-state across last 20 (docs-only commits correctly CANCELED by `ignoreCommand`).
- **Post-ship watch (last 24–48h):** ALL PASS, 0 reverts. `edition_integrity_flags` metric fix works as intended (reads 100, ok). `recent-sales` hydration fix (`07811f27`) deployed READY, 0 new Sentry. All other 07-28 commits are test-only (both CI ratchets green on HEAD).
- **Artifacts:** 14 enumerated, none flagged broken (inbox empty); no schema drift this run (additive suppression row only). No repair needed.

### Overnight deltas vs 2026-07-27
- FMV HIGH+MED: TopShot 2861→**2860** (flat), All Day 431→**423** (−8, noise), UFC 15 (flat), Golazos 3 (flat).
- DB size 11,210→**11,344 MB** (+134).
- `unmapped_resolution_backlog_max` 64→**63**. `sentinel_ts_uuid_editions_48h` 0. `fmv_sanity_flags` 0. `ts_uuid_dupes_created_24h` 0.
- `edition_integrity_flags` 5→**100** (metric redefinition, above).

---

## Queued (nothing new to ship autonomously this run)

No new inbox candidates tonight (monitor pushed none since the 07-27 files were archived). All standing queued items remain off-limits, gated, hot-file-blocked, or operator-owned — carried forward unchanged:

- **ALLDAY-DECODE-LEG-EFFICACY** — resolver route logic (ingest-adjacent, off-limits); ready-to-spec narrowing in the 07-27 handoff.
- **ALLDAY-UNMAPPED-SALES-BACKLOG-GROWTH** — info, net-draining (~5.7d); resolver-throughput, off-limits.
- **SET-DETAIL-PAGE-POOL-RETRY-GAP** — LOW code fix; hot-file blocked.
- **TS-PACK-OPENS-HISTORY-CURSOR-FASTFORWARD** — Cowork-queued 07-27; cold-spork 500 (needs GATE key).
- **CANDY-CLASS-PURGE-GUARD-FLOW-CACHES** — Cowork-queued 07-27; FMV-feeding, hand-off.
- **DUNE-DATAPOINT-CAP-402** — operator/billing (Dune datapoint cap; cursor parked at 2021-12).
- **TS-PARALLEL-SUBEDITION-CIRCULATION-STRAGGLERS** — the 53 canonical `setID:playID::subID` parallels missing parallel-specific circulation that `edition_integrity_flags` now tracks; correct value = on-chain subedition supply (ingest domain), guessing would inject wrong scarcity into FMV/pack-EV. Left for the subedition circulation sweep.
- Standing longer-tail: REFRESH-SEEDED-WALLET-STATS-HOLDINGS-SUMMARY-COST, CORRELATED-PIPELINE-DROPOUT-DETECTOR, PIPELINE-WATCHLIST-COVERAGE-AUDIT, TOPSHOT-BADGE-CATALOG-429, WMC-PRUNE-120S-CEILING, NON-WAVE-WALLET-BACKFILL-DRIVER, CLAUDE-MD-GOLAZOS-LOW-ASK-STALE, Panini go-live (Trevor editorial), chain-two/Candy public go-live (gated).

## Failed / blocked / reverted

None. No verification failures; no hard-stop triggered.
