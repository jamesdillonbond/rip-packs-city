# Overnight pass handoff — 2026-06-28

**Mode:** GENUINE OVERNIGHT (in-window). Fired at real ~01:02 PDT (08:02Z). **No clock skew** — shell `date -u` 08:02Z == DB `now()` 08:02Z == app-stamped `sales.ingested_at` 07:56Z / `fmv_snapshots.computed_at` 07:58Z (production rows can't be future-stamped, so they bound real time from below). Push **available** (`git push --dry-run` = "Everything up-to-date"). No `docs/FREEZE.md`. Concurrency lock was RELEASED + ~17h stale → taken over.

**Outcome:** Shipped **0 production changes** (correct — a green night with no warranted, fully-gated, verifiable low-risk candidate). 1 docs-only fix (the Pinnacle-FMV table-name footgun in CLAUDE.md). Auto-reverted 0, repaired 0 artifacts, **closed 4** queued items. origin/main `38565d9a` unchanged start→end. Drained 2 inbox files.

---

## Git / environment
- Sandbox-native clone `$HOME/rpcwork` (`git clone --filter=blob:none`), pushurl harvested from the mounted repo's `remote.origin.pushurl` (never printed). All git ops in the clone.
- origin/main at start AND before each write: `38565d9a` (the 06-28 00:09Z daytime-monitor commit). No human/CC pushing during the run.
- Lock: `docs/overnight/.lock` (mount) was `RELEASED` from the 06-27 run (~17h old) → took over, wrote a HELD marker, will mark RELEASED on exit.

---

## Inbox drained (2 files)
1. **`2026-06-28T001728Z-daytime-monitor-pinnacle-fmv-name-stale.md`** (clone/origin) — NEW LOW candidate PINNACLE-FMV-TABLE-NAME-STALE → **actioned** (CLAUDE.md doc fix below); the artifact-footer half folded into WEEKLY-SURFACE-QA-PROSE (queued, not reinstalled).
2. **`2026-06-27T185737Z-cowork-insights-qa-closures.md`** (mount-only, from an interactive Cowork session) — closes NEW-COLLECTORS-INSIGHTS-QA + ROOKIE-BOARD-INSIGHTS-QA (live/visual leg PASS) → **actioned** (both marked CLOSED in the ledger).

Both archived to `docs/overnight/inbox/archive/` (clone + mount).

---

## Post-ship regression watch — ALL PASS, 0 reverts
Re-measured the metric each change in the dense 06-27 daytime CC wave (`db95f76`→`16e65d7`, ~16 commits) was meant to move. Independent verification, not a re-read of the monitor.

| Ship | Target | Re-measured this run | Verdict |
|---|---|---|---|
| `f130face` wmc-fossil on-chain re-key (Item 2) | fossils 1748→0 | `ts_wmc_uuid_fossils` (TS wmc edition_key `~ '-'`) = **0**; sentinel TS-UUID-48h = **0** | PASS |
| `16e65d7` scope unmapped backlog to recent-30d | trust 13/13 | `rpc_ops_snapshot` trust 13/13, breaches []; `unmapped_resolution_backlog_max` = **26** (breach_at 100) | PASS |
| `0a684d2` sentinel_threshold_config | table-driven thresholds live | `sentinel_threshold_config` = **6 rows** | PASS |
| `611b2fb` concurrency guard + GHA backstop (wallet/snapshot) | no SPOF, no double Cadence | `pipeline_run_locks` live (316 rows); `wallet-backfill` latest 07:27Z ok, `snapshot-institutional-wallets` 06-27 20:43Z ok, `lock-check-batch` 07:38Z ok | PASS |
| `c688f67` pack-dist observed lifecycle + EV reality-check | views return sane data; page READY | `v_topshot_pack_lifecycle` **1989 rows**, `v_topshot_pack_realized_ev` **201 rows**; deploy `GTjUC7yCC6` READY | PASS |
| `04f96f2`/`4b2c6a6`/`5caeabe` AllDay current-holder resolver | drain ALLDAY-V1-UNMAPPED-DRIFT | `allday-unmapped-resolver` latest 07:56Z ok (candidates 396, scan_chunks 36, promoted 0 — the unresolvable hard tail; owned) | PASS |
| `cfe034e` sales-indexers GHA backstop | redundant, no double-write | sales indexers fresh; no dup-key class | PASS |

Prod `c688f673` READY, 0 ERROR. The 2 commits newer than prod (`b5c7d133` docs-ledger, `38565d9a` monitor) are CANCELED — correct docs-only `ignoreCommand` behavior.

---

## Health-drift triage (baseline `rpc_ops_snapshot()` @ 08:05Z) — GREEN
- **Security:** invariants [] · anon_write_holes [] · rls_off_base_tables [] · secdef_anon_violations [] → **0/0/0/0**.
- **Trust health:** **13/13 ok**, breaches []. unmapped 26/100, edition_integrity_flags 4/50, fmv_sanity 0/1, ts_uuid_dupes_24h 0/200, all per-collection `*_fmv_stale_hours` ok (pinnacle 22/30, topshot 0.3/6, allday 0.3/12, golazos 0.3/30, ufc 0.1/30).
- **Pipelines:** `detect_stalled_pipelines()` [] · `get_pipeline_alerts()` [] · `check_pgcron_recent_failures()` []. Fails 24h: 5 pipelines (wmc-fmv-populate 3, offers-sweep 2, compute-topshot-pack-ev 1, lock-check-batch 1, topshot-buyer-backfill 1) — **every one's latest run is ok=true** (transient timeouts / TS-GQL 429, all recovered).
- **Sentinel:** TS-UUID-editions-48h = **0** (was 34 inert; cleared by the fossil re-key).
- **Editions:** FLAT — TS 17,471 / AllDay 6,191 / Golazos 581 / UFC 518. No writer leak.
- **FMV:** TS HIGH+MED **4,604** (1308+3296, improving from 4,594) / AllDay **909** (251+658, improving from 905) / UFC 15 / Golazos 5. fmv_sanity_flags 0.
- **DB size:** 6,391 MB (+109 over ~24h — benign backfill-wave growth; monitor saw +63 at 00:09Z).
- **Sentry:** **0 unresolved issues in 24h** (cleaner than the prior run's 5 stale flakes).
- **Vercel:** prod `c688f673` READY, 0 ERROR across the wave.
- **Artifacts:** 13 in manifest, all active (matches monitor 00:09Z). None flagged broken in any inbox tick; none repaired (read-only night).

---

## SHIPPED — docs-only (does not count against the production budget)

**PINNACLE-FMV-TABLE-NAME-STALE — CLAUDE.md Known-issues #4 corrected.**
- **Problem:** CLAUDE.md still stated Pinnacle FMV "lives in its own `pinnacle_fmv_snapshots` table … recomputed daily by algo `pinnacle-1.0.0` … holds 425 editions." That table was DROPPED 2026-06-08 (survives only as `pinnacle_fmv_snapshots_backup_20260608`); a query against `pinnacle_fmv_snapshots` now `42P01`-errors. This sat inside a "CRITICAL — verify before writing queries" section → an active footgun that could send a future session into a broken query.
- **Fix (line 741):** rewrote to the live truth, re-verified this run via `information_schema` + `to_regclass`: render-keyed `pinnacle_fmv_history` (cols `render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at`; 13,436 rows, 1,826 renders priced in 2d), engine `pinnacle-2.0.0-render`; explicitly notes the old table was dropped → 42P01. Left the legitimate `pinnacle_fmv_snapshots_backup_20260608` reference intact.
- **Risk:** docs/prose only — no code/DB/runtime impact; docs commit CANCELED by the `ignoreCommand` (no deploy).
- **Revert:** `git revert <this commit>`.
- **Target metric:** zero future broken Pinnacle-FMV queries sourced from CLAUDE.md.

---

## CLOSED (4)
1. **TS-WMC-UUID-FOSSILS** — RESOLVED by CC `f130face` (on-chain re-key via `drain-topshot-misattribution ?wmc=1`, UPDATE not DELETE — so the Trevor "do-not-delete" decision was honored). Verified `ts_wmc_uuid_fossils` 1748→**0**, sentinel 0. Revert (CC's) via the f130face per-row audit table.
2. **ALLDAY-FMV-POPULATE-NOOP-STALL** — the `pipeline_cadence_watchlist` row is already `is_active=false`, so `detect_stalled_pipelines()` + `get_pipeline_alerts()` both [] (the false-positive is neutralized). No DELETE shipped — deactivation is the more reversible state and fully resolves the symptom (the queued DELETE is no longer needed).
3. **NEW-COLLECTORS-INSIGHTS-QA** — Cowork live/visual QA (mount inbox) PASS: anon API 200, debiased new-count copy + "directional" caveat, cohort methodology footer, brand tokens. No fixes.
4. **ROOKIE-BOARD-INSIGHTS-QA** — Cowork live/visual QA PASS: KPI header, sort toggles, SQUEEZE/TROPHIES drill-downs (TROPHIES suppressed with no #1-mint history), honest em-dash nulls, brand tokens. No fixes.

---

## QUEUED / carried (no NEW items this run)
All owned/operator/gated; none are night-pass-shippable:
- **WEEKLY-SURFACE-QA-PROSE** (now also the rpc-live-health Section-3 footer string `pinnacle_fmv_snapshots`) — **cosmetic only**; the board's `CONSOLIDATED_SQL` already reads `pinnacle_fmv_history` and has loaded fine for 19 days. A full-file reinstall of the monitor's own ~550-line board to fix two prose strings is the wrong risk trade for an unattended pass (same standing decision as prior passes). Do it in an interactive prose-fix reinstall.
- **ALLDAY-V1-UNMAPPED-DRIFT** (owned) — resolver healthy post the 06-27 fixes; the remaining tail is genuinely unresolvable (moments moved to non-public/escrow/burned; no later Deposit event). Trevor decision.
- topshot-sales-history-backfill watchlist; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); VERCEL cost family; A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC-owned); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2.

**STEER honored (do not re-flag):** SERIAL-FMV-MULT-CRON is by design (weekly pg_cron); evm-transfers-ingest Base-429 benign; the TS-Flowty unmapped class is drained not retired (Declined to skip/retire/raise-threshold); the studio-platform deep-history program is post-ship-watch-only.

---

## Failed / blocked / reverted
None. No verification failures, no auto-reverts, no production hard-stop. Quiet green night.
