# RPC overnight autonomous pass — 2026-08-05 (~01:06 PDT)

**Mode:** GENUINE OVERNIGHT, git RESTORED. Fired 08:06Z / 01:06 PDT, inside the 00:00–06:00 local window; no clock skew (DB `now()` 08:06:48Z ≈ max sale ingested 08:03:06Z ≈ max fmv 08:06:25Z). Prior lock RELEASED. Push available (`git push --dry-run` → up-to-date). Supabase + Vercel + Cowork + Sentry connectors all live.

**Outcome:** **Ship 0 / revert 0 / repair 0.** Quiet, honest night. Health green-with-known-noise; the one substantive candidate (wallet-username-resolver timeouts) was profiled and found to have **no low-risk additive fix** — QUEUED with a full diagnosis. Everything else in the inbox is already-fixed, self-healing, or a documented non-defect. Post-ship watch of the 08-04 daytime CC wave: **ALL PASS, 0 regressions.**

> ⚠ **Sandbox note:** the earlier "no space left on device" class recurred — `$HOME` (`/sessions`, 90% full, ~1 GB free) could not hold a full checkout, so the clone was placed in `/tmp` (root fs, 4 GB free) instead. Git was otherwise fully functional this run (fetch/log/push all worked).

---

## Setup & gates
- **Lock:** prior lock was RELEASED (08-04 overnight). Took a fresh lock `night-20260805T080601Z-4885` on the mount at 08:06Z. Released at end of run.
- **Freeze:** none (`docs/FREEZE.md` absent).
- **Quiet-hours:** genuine overnight (01:06 PDT), normal shipping-eligible posture.
- **Push:** available. Collision gate: `origin/main` HEAD = `bc99369c` at clone; latest **production** deploy `dpl_BTXL6RPECXucZ19LtoeKwdJ8mSyE` (`bc99369c`, disconnected-ask disclosure view) READY. No movement, no ERROR-state deploys (an active concurrent CC session is pushing feature branch `claude/todo-implementation-qi4350` — preview builds only, does not touch `main`).
- **Inbox:** 3 files folded — `2026-08-04T1513Z.md`, `2026-08-04T2114Z.md` (both in origin), `2026-08-05T0615Z.md` (mount-only, from the 06:15Z monitor tick ~2h ago). All archived this run.

## Post-ship regression watch — ALL PASS (0 reverts)
Last night's overnight pass shipped 0 (NO-GIT), so the watch covered the **08-04 daytime CC wave**. No regression traces to any of them:
- `639e1eff` **stale-fmv-monitor bound** — ledger already verified in prod (504×3 → 200 in ~6s, live workflow_dispatch). `stale-fmv-monitor` absent from pipeline alerts. Healthy.
- `bc99369c` **`v_fmv_thin_sale_ask_disclosure`** (additive, anon-revoked, batch-only) — its only knock-on was the `fmv_clamp_disconnected_ask` ACL (a `CREATE OR REPLACE` on an adjacent function reset the ACL and dropped `cron_heavy`'s EXECUTE). CC already re-granted (`a9960e16`). **Verified live: `proacl = {postgres=X, service_role=X, cron_heavy=X}`** — the grant is back. The daily `55 8 * * *` clamp job next runs 08:55Z (49 min after this pass) — its success is a post-ship-watch item for the daytime monitor.
- `5c74003e` **collection FMV-method label**, `04dbb1b8` **sniper ask-only thin-data flag** — cosmetic/disclosure fixes; no behavioral regression, no new Sentry class.
- `caf6cc07` panini migrations recovery + `panini_sale_price_capture_dry_days` — the metric was ADDED to instrument an upstream outage; the breach is upstream, not a regression.
- **Corroborating deltas (all improving):** `fmv_sweep_stall_pct_24h` 45.2 → **4.4** (the queued maxDuration item largely self-resolved), `candy-editions-ingest` no longer stalled (`stalled_pipelines` = []), `allday-unmapped-resolver-tail` failure rate 45.5% → 27.8%, last night's `sales_serial_supply_worst_pct` breach stayed cleared (0.33).

## Health-drift triage (Section 2)
Baseline via `rpc_ops_snapshot()` @ 08:07Z.
- **Security:** fully clean — invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **Stalled pipelines:** `[]`.
- **Trust-health breaches (3), all KNOWN non-defects:**
  - `panini_sale_price_capture_dry_days` = 8 (breach_at 3) — upstream Panini outage (0.00% sale prices supplied since 07-29; `panini_sale_field_mapping_shortfall` = 0, so our ingest is faithful). Different owner, self-clears when upstream resumes. Watch-only.
  - `public_board_slow_count` = 7 (breach_at 1) — **up from 4 last night.** The documented "plans optimal / do not re-budget autonomously" load/threshold class. Snapshot taken shortly after the 06:0x IOPS-contention window; the metric reflects board latency under contention, not a query defect. Noted, not actioned (CLAUDE.md is explicit: do not re-budget autonomously).
  - `unmapped_resolution_backlog_max` = 105 (breach_at 100) — draining by design, info-level. Its own `catches` text says do NOT raise breach_at.
- **pg_cron recent failures (3), all benign:** `rpc-fmv-clamp-disconnected-ask` = the stale 08-04 08:55Z permission-denied (already fixed, ACL confirmed); `rpc-refresh-topshot-edition-median` (06:10Z) and `rpc-refresh-allday-pack-realized` (06:35Z) = CONCURRENT MV-refresh statement-timeouts in the 06:0x IOPS-contention window (self-healing — the MV keeps serving prior data).
- **Sentry:** 4 unresolved in 24h, all the documented entity-page saturation class (`NEXTJS-23` player, `NEXTJS-20` player schema-cache, `NEXTJS-1Z` pack detail, `NEXTJS-1Y` team) — 1–4 events each, no new class, none tracing to the CC wave. No spike.
- **Pipeline alerts:** `wallet-username-resolver` 33.9% timeout (→ queued below), `allday-lock-refresh` 27.8%, `allday-unmapped-resolver-tail` 27.8% (improving), `sync-nba-projections` 31.6% all_upstreams_failed (off-season external), `topshot-active-listings-ingest` 36.4% egress_blocked (external), `unmapped-sales-nfl_all_day` info/draining. All known classes.
- **Artifacts:** 11 enumerated via `list_artifacts`; none flagged broken by the monitor, and `rpc-live-health` was validated healthy by the 08-04 monitor. Per the fresh-on-open rule, none regenerated.

### Overnight deltas vs 2026-08-04 metrics-latest.json
| metric | 08-04 | 08-05 | note |
|---|---|---|---|
| FMV HIGH+MED (TS) | 6855 | 6800 | flat (2062 HIGH + 4738 MED) |
| FMV HIGH+MED (AllDay) | 1618 | 1586 | flat (280 + 1306) |
| FMV HIGH+MED (Golazos) | 3 | 3 | flat |
| fmv_sweep_stall_pct_24h | 45.2 | **4.4** | ↓ big improvement |
| public_board_slow_count | 4 | 7 | ↑ contention (documented non-defect) |
| unmapped_resolution_backlog_max | 105 | 105 | flat, draining |
| edition_integrity_flags | 97 | 97 | flat |
| fmv_sanity_flags | 0 | 0 | clean |
| sales_serial_supply_worst_pct | 0.14 | 0.33 | ok (breach_at 5) |
| DB size (MB) | 11987 | 12108 | +121, normal growth |
| stalled_pipelines | candy-editions | [] | resolved |
| sentinel_ts_uuid_editions_48h | 0 | 0 | clean |

---

## QUEUED

### NEW — WALLET-USERNAME-RESOLVER heavy selector query (profiled; not low-risk-additive)
- **Symptom:** `wallet-username-resolver` fails 33.9% (37/109 over 2d) with `canceling statement due to statement timeout`. Flagged MEDIUM by the 08-04T1513Z monitor with a request to profile.
- **Root cause (profiled live, TWO warm EXPLAIN ANALYZE runs, 81.9s then 85.3s):** the selector RPC `wallet_usernames_unresolved(p_limit)` (own `statement_timeout` = 60s) re-aggregates the **entire 21-day counterparty universe** every ~20 min — buyer+seller of `sales` (~68k rows each via `idx_sales_2026_pulse_window`) plus buyer+seller of `pack_purchases` (~40k + ~28k) — to return only the handful of newly-unresolved addresses (actual output: **4 rows**). The plan is already healthy (Index-Only Scans, partition pruning `Subplans Removed: 6`), but the **working set is ~630 MB (~80k buffers, ~33k cold reads that don't stay resident on the Micro instance) with ~104k Heap Fetches** from stale visibility maps on the two hot append tables. It legitimately exceeds 60s under any load.
- **Why no low-risk additive fix (measured, not assumed):** the covering index already exists (`idx_sales_2026_pulse_window = (collection, sold_at DESC) INCLUDE (price_usd, buyer_address, seller_address)`; `idx_pack_purchases_buyer/seller`). A new index does not reduce Heap Fetches (they are a function of VM staleness on recently-appended pages), and a VACUUM decays within hours on hot append tables (the same reasoning the 08-04 stale-fmv-monitor entry used to decline a `sales` sold_at index). So the levers are behavioral/external, not additive:
  - **Option A (operator, highest value / lowest code):** cut the cron-job.org cadence from ~20 min to hourly or 2-hourly. It yields ~4 new addresses per run against a 14-day negative cache on a pure display nicety (@handle vs 0x), so 3–6× less load with negligible freshness cost. cron-job.org console is operator-only.
  - **Option B (code, needs testing):** rewrite the RPC to an incremental watermark (only aggregate counterparties newer than the last resolved high-water mark) or a much narrower window. This is a **live-function replacement** on a resolver, so it wants its own tests + verification — not a blind overnight ship.
- **Non-critical / no data loss:** transient errors leave the address for the next tick (no row written); the pipeline still succeeds ~66% of the time. The cost is wasted invocations + pooled connections held during the 60s scan, which feeds the daily contention window.
- **Night-count:** 1.

### NEW (LOW / cosmetic) — TOPSHOT-FLOWTY-BACKFILL cursor_stalled false positive
- `get_pipeline_alerts()` carries a standing `cursor_stalled … high` for `topshot_flowty_backfill` pinned at block `137390146` = `SPORK_FLOOR_HINT`, the current-spork floor the backfill deliberately hard-stops at (per focus.md). Cosmetic alert-channel dilution, no data impact. Flagged by the 08-04T1513Z monitor.
- **Not shipped:** the fix teaches the cursor-stall check to treat a cursor pinned at `SPORK_FLOOR_HINT` as expected — that modifies live alert logic and risks masking a genuine stall if done imprecisely, for a purely cosmetic gain. Low priority. Night-count: 1. (Note: the 08-04 ledger shows a related "4th spork-floor cursor_stalled twin" suppression was already handled — confirm this is a distinct standing instance before acting.)

### CARRIED (from 08-04 metrics / prior)
- **FMV-RECALC-MAXDURATION 300→800** — DE-PRIORITIZED: `fmv_sweep_stall_pct_24h` fell 45.2 → 4.4, far under breach_at 50, so the sweep is no longer stalling. The route's `maxDuration=300` still has headroom to 800 if kills recur, but no longer pressing.
- **ALLDAY-RESOLVER-TAIL UNION split** — DECIDED do-not-ship (08-04 ledger); the premise was a measure-across-the-deploy-boundary artifact. Re-measure after ~2026-08-10 when arm B first returns rows. Watch.
- **CANDY-EDITIONS paginateGroup** — de-prioritized: candy-editions no longer stalled (maxDuration 300→800 fix took). Revisit only if it re-times-out at 800s.
- **Standing queue:** edge-orchestration testing, non-wave wallet-backfill driver, DUNE seller-recovery inert (`DUNE_SALES_SELLER_QUERY_ID`), chain-two gated.

## Failed / blocked / reverted
None. Nothing shipped, nothing reverted, no verification failures. No hard-stop triggered.

## Post-ship-watch items for the daytime monitor
- Confirm the `fmv_clamp_disconnected_ask` `55 8 * * *` job logs `succeeded` at 08:55Z today (ACL fix confirmed in place; could not be observed pre-08:55Z this run).
- Continue watching `fmv_sweep_stall_pct_24h` (now 4.4, was 45.2) to confirm the sweep stays healthy.
- `public_board_slow_count` 4→7 — confirm it settles once outside the 06:0x contention window; do NOT re-budget autonomously.
