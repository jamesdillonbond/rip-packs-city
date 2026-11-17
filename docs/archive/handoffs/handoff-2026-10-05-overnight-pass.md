# Overnight pass — 2026-10-05 (~1:10 AM PT, Cowork cloud, unattended)

> ⚠ **Environment scope.** The git-push constraints discussed anywhere in this project are specific to the **Cowork cloud session**. Trevor's machine and Claude Code push normally via Git Credential Manager — **commit as usual.** This pass WAS push-capable (desktop-VM clone + `.rpc-git-cred`; `git push --dry-run` exit 0), so its docs are committed to `main`.

**Mode:** genuine overnight run. Real time established from the DB (`now()` 08:08Z) vs shell (08:08Z) vs app-stamped rows (`max(ingested_at)` 08:08Z, `max(fmv_computed)` 08:08Z) — clocks agree, no skew; **01:08 AM PT**, inside the 00:00–06:00 window. Lock taken (`run-1791187748-24477`), released at end. No `FREEZE`. Push green.

## Verdict: GREEN. 0 shipped, 0 reverted. A quiet honest night.

Nothing met the clearly-safe-and-net-positive bar. The one candidate addressed to Cowork this run (the `0410Z` Flowty handoff) is destructive SQL + operator-gated + blocked by the MCP write-hold, so it is queued for Trevor / Claude Code, not shipped.

---

## 1. Reviewed

**Inbox (new since the 10-04 ~1:10 AM PT pass):**
- `2026-10-05T0410Z-flowty-thread-handoff-dedupe-drop-and-173.md` — 🟠 handoff to Cowork (dedupe + scratch-drop + #173). **Dispositioned → QUEUED** (§Needs Trevor). Pre-checks verified live tonight.
- `2026-10-05T031053Z.md` — 🟢 daytime-monitor repeat (chain-arrivals seed timeout already fixed; Candy bid book empty benign). Already dispositioned by Claude Code; **no action**, confirmed consistent with live state.

**Also folded:** CLAUDE.md open lists, focus steers (10-03 → 10-04 ~10:45 PM PT), the 10-04 ledger ships (post-ship watch below), Vercel 24h errors, the client-error beacon. No `docs/FREEZE.md`.

## 2. Health-drift triage — GREEN

Fast baseline `rpc_ops_snapshot()` @ 08:11Z + the instruments that lie, each drilled:

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base `[]`, secdef_anon `[]`. Clean.
- **Structural:** function_search_path_drift / procedure_txn_control_pins / procedure_search_path_unpinned / cross_collection_mat_staleness / backward_cursor_rewinds / wmc_null_edition_key / suppression_parked_claim_drift — all `[]`.
- **Trust health:** 0 breaches, all 38 arms `ok`. `trust_precompute_max_age_hours` 5.38 (breach 13). `public_board_slow_count` 0, `public_board_empty_count` 0.
- **R118** `check_when_others_timeout_blind()` = 0. **Zero-yield** offenders `[]` (315 inspected, 3 suppressed, 0 excluded_by_writes). **Sentinel** `ts_uuid_editions_48h` 0.
- **stalled_pipelines** `[]`. **pgcron recent failures:** only `rpc-chain-arrivals-seed` (last_run 11:13Z **10-04** — PREDATES its own fix `20261004160000` @ 16:00Z 10-04; STALE per the standing rule, re-runs ~11:13Z 10-05; the daytime 7:45 AM PT routine reads it).
- **pipeline_alerts:** all info/medium, every one known-class — `atlas-edition-supply` med (CF-403 base rate, do-not-reflag), `panini-collector-walk` med (10-min cap, by design), `pack-mint-probes` info (streak-split cleared, lit-by-design on the historical node), `unmapped-sales-nfl_all_day` info (15,269 open, ~2.2 d to clear; was 23,325 on 10-04 — draining), atlas-*-upstream-403 / flow-rest-moment-moved-400 info (by-design).
- **Vercel 24h:** 14 groups, all **chronic** (pack_lifecycle 5 s since 08-23, ipfs-media 12 s timeout since 09-03, edition special-serials degrade-to-empty since 07-31, parallel-premiums 8 s, relative-deals, collection-snapshot, set-activity degrade, get_set_editions structural-throw since 08-02 — 1 occurrence 08:06Z, honest section-degrade) **+ the now-cleared Panini board cluster** (last 12:37Z 10-04, after the 10-04 covering indexes — holding). **No new error group.** Vercel near-chronic-only, so the Sentry-dark zero is corroborated as real health (Sentry dark since 08-18, no spend — not used as a signal).
- **Client-error beacon:** 3 in 24 h (unchanged, healthy).
- **DB size:** 34,535 MB, +2,562 vs 10-04 (31,973). Slowing (the 10-03→10-04 delta was +7,943). Flowty index tables + chronic `net._http_response` log. Not runaway. Dropping the scratch set (queued item 2) reclaims ~185 MB. Carried as a watch.

### Accuracy gate (the GATE — `fmv_sales_backtest`, 7 d)
- **NBA Top Shot:** published ALL median_ratio **1.000**, median_abs_err 13.0 %, within-25 % 71.8 % (n 18,581); HIGH 9.1 % err, within-25 % **87.3 %**, ratio 1.000. `last3_median_30d` ALL ratio 1.000 / err 12.0 %. Tracking the market.
- **NFL All Day:** published ALL median_ratio **1.20** (err 26.7 %, within-25 % 46.8 %, n 5,135) **but median_abs_err_usd $0.05** — its known sub-dollar market (93 % of sales < $1, so a few-cent miss is a large %); HIGH ratio 1.10, err 16.7 %, usd $0.03. Snapshot fresh (05:35Z), ingest current → not a lagging estimator, the structural penny-market characteristic. No change owed; pricing route is off-limits regardless.

## 3. Post-ship regression watch (10-04 ships; re-measured, none regressing)

- **`fmv-backfill` MATERIALIZED-CTE fix (`20261005001848`, @ 00:18Z 10-05):** HOLDING. The one post-fix run (02:12Z / 7:12 PM PT 10-04) ok in **4.4 s**. Both timeout rows in the last 10 (23:21Z and 06:23Z 10-04) **predate** the fix. Falsifier (any statement-timeout after 00:18Z) not triggered. Watch continues: next 5 runs ≤ 10 s.
- **Panini board covering indexes (`20261004123243` / `124114` / `124411`):** HOLDING. No `refresh-insights-cache` board timeout since 12:37Z 10-04.
- **`chain-arrivals-seed` fix (`20261004160000`):** can't verify this run — the seed job next fires ~11:13Z 10-05 (after the fix); its last run (11:13Z 10-04) predates it. Daytime 7:45 AM PT routine is the check.
- **Top Shot team-moment `player_name`/name (`20261004232750` / `230911`):** the 2:50 / 2:55 AM PT player mint/link jobs haven't run yet (01 AM PT) — the 8 AM PT 10-05 check owns this.
- **`allday-lock-refresh` cadence fix (`101f9c18e`):** rows_written/day expected to fall from 10-06 — too early. `wmc-reindex-verify` clears Sat 10-10.
- **Flowty re-promotion (10-04):** no regression signal; the 7 tx-lane duplicates it left are queued below (item 1).

### Minor observations (not findings, not shipped)
- `chain-arrival-flips` 10 fails/24h — all Flow-node `http 400 "failed to convert event payload"` (known upstream node fault, same class as the 1505Z filing's item 2); last 23:43Z 10-04.
- `wallet-backfill-golazos` 5 fails/24h — Flow `computation_limit_no_paginated_path` on the Golazos wallet walk (Golazos is genuinely market-limited; upstream compute limit). Low impact; worth a daytime glance only if it grows.

## 4. Shipped

None.

## 5. Needs Trevor / queued

1. **`dedupe_tx_lane_20261004.sql` then `drop_scratch_20261004.sql`** (`0410Z` filing; Trevor-authorized in that filing, but **destructive SQL** — `DELETE` + `DROP` — which (a) the autonomous pass never auto-ships per its off-limits set and (b) the MCP write-hold cancels unseen from a headless session, and both need the Supabase **SQL editor**). **Pre-checks verified live tonight (read-only):**
   - dedupe pre-check (7 tx-lane rows duplicating a walk row): **7** — matches, ready. Post-check after run: that query → 0; `audit_20261004_tx_lane_dupes` → 7. Revert: `INSERT INTO public.sales SELECT * FROM flowty_archive.audit_20261004_tx_lane_dupes;`
   - scratch-drop pre-check (`cron.job` commands referencing `flowty_archive.scratch`): **0** — safe, no live job references the scratch objects. Run drop AFTER dedupe. Post-check: 0 scratch tables, 0 scratch functions in `flowty_archive`. No revert needed (re-creatable from the preserved bodies).
   - Order matters (dedupe first). Both files are single `BEGIN…COMMIT`, guarded (RAISE/rollback on a wrong count). An MCP timeout ≠ failure — re-run the post-check before retrying. Log each in the ledger the same turn.

2. **#173 — `topshot_moment_subeditions` conflated base editions (INVESTIGATE / do not ship).** Refined sizing added tonight: the table is **1,365,224 rows** total (`resolved_at` 2026-06-20 → 2026-10-04); the "2 % sample → 26/12,030 ≈ 0.2 %" in known-issues is over the **checkpointed** comparison population, not the table. The `resolved_at` 06-20→07-06 cohort is **368,171 rows** — i.e. the whole initial seed window, so `resolved_at` does **not** narrow the writer. The exact count needs the checkpoint join in slices; the writer-attribution needs reading the named writers' bodies (`sales-indexer`, `topshot-sales-history-backfill`, `ingest`, `refresh-conflated-editions`/`drain-conflated-subeditions`, the `remap_topshot_*` family + the 10-04 `20261004153801` i171 rekey); and the downstream touch needs `sales.edition_id` / `wallet_moments_cache.edition_key`. Pricing-adjacent, many readers → **Claude Code's or Trevor's to ship**, as the filing says. Left as an open inbox item; not retired.

3. **(carried, NON-ACTION) ~560 inbox filings "archival backlog".** This is NOT a task — the inbox is **append-only** and CI-pinned; archiving post-08-17 filings reds `main` (happened 10-04, restored `815c984`). Prior metrics-latest listed it under `needs_trevor`; it is the intended steady state. The only valid hygiene is a stub/redirect or INDEX, never `git mv`.

4. **(watch) `net._http_response` ~3.5 GB chronic pg_net log bloat + overall DB growth.** Pruning is a `DELETE` on pg_net infra (write-held, and not an autonomous lever). Carry; revisit if growth re-accelerates.

## 6. Failed / blocked / reverted

None. No verification failure, no revert, no hard-stop.

---

*Continuity written: this handoff (clone + mirrored to the claude.ai Project); ledger `### 2026-10-05` entry; `metrics-latest.json` overwritten; lock released. No inbox filing retired (none resolved). No code, no DB change, no deploy.*
