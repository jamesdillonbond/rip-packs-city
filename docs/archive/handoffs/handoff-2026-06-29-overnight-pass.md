# Overnight pass handoff — 2026-06-29

**Mode:** GENUINE OVERNIGHT (in-window). Fired at real ~01:03 PDT (08:03Z). **No clock skew** — shell `date -u` 08:02Z == DB `now()` 08:03Z == app-stamped `sales.ingested_at` 08:03Z / `fmv_snapshots.computed_at` 07:58Z (production rows can't be future-stamped, so they bound real time from below). Push **available** (`git push --dry-run` = "Everything up-to-date"). No `docs/FREEZE.md`. Concurrency lock was `RELEASED` + ~23.7h stale → taken over.

**Outcome:** Shipped **0 production changes** (correct — a green night; the single inbox candidate is FMV-adjacent, not urgent, and not in-run-verifiable → QUEUED with a ready-to-run fix). Auto-reverted 0, repaired 0 artifacts, closed 0. origin/main `ad1aeb5f` unchanged start→end. Drained 1 inbox file. **1 NEW queued** item.

---

## Git / environment
- Sandbox-native clone `$HOME/rpcwork` (`git clone --filter=blob:none`), pushurl harvested from the mounted repo's `remote.origin.pushurl` (never printed). All git ops in the clone.
- origin/main at start AND before each write: `ad1aeb5ffc42c06dc594e82ccdf74c23a04c72bd` (the 06-29 06:15Z `ad1aeb5f` trophy-slab feature). No human/CC pushing during the run.
- Lock: `docs/overnight/.lock` (mount) was `RELEASED` from the 06-28 run (~23.7h old) → took over, wrote HELD marker, RELEASED on exit.

---

## Inbox drained (1 file)
- **`2026-06-28T1512Z.md`** (15:12Z daytime monitor, first tick of day) — health GREEN; one new candidate **SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT** → investigated + QUEUED (below). Archived to `docs/overnight/inbox/archive/`.

---

## Post-ship regression watch — ALL PASS, 0 reverts
Re-measured the metric each change in the heavy 06-28 daytime CC wave (`7c7ce83a`→`ad1aeb5f`, ~9 commits: pack-EV "sessions 6/7" + view-security hardening + trophy-slab) was meant to move. Independent verification, not a re-read of the monitor.

| Ship | Target | Re-measured this run | Verdict |
|---|---|---|---|
| `ba3b010` session-7 security invariant extended + 9 view write-grant holes closed | invariants stay 0; no anon/auth view-write vector | `rpc_ops_snapshot` security **0/0/0/0** (invariants/anon_write_holes/rls_off_base/secdef_anon all []) | PASS |
| `ba3b010` restore `cross_collection_deals_board` security_invoker=on | the project's only definer-view ERROR → 0 | `reloptions` = `{security_invoker=on}` (restored & holding) | PASS |
| `dadf9736` default-ACL root fix (revoke anon/auth table writes going forward) | no new public-key write holes | anon_write_holes **[]** | PASS |
| `ba3b010` non-destructive TS pack seeder (RPC + edge-fn v20) | `total_minted` not reset to 0 | `pack_distributions` TS: **1990/1990 minted>0, 0 zero/null**, 1981 opened>0, max 385,101 | PASS |
| `7c7ce83a` pool-backfill mode=pool repair (gql_historical) | cron runs ok, not erroring | pack-EV crons all `ok=true`; `backfill-pack-rip-metadata`/`pack-events-ingest(-backfill)`/`compute-*-pack-ev` latest ok | PASS |
| `5ee2574` calibrated EV on `v_topshot_pack_realized_ev` | view sane; pack-EV board fresh | view security_invoker=on; trust `pack_ev_board_max_stale_days` 0.48/2, `pack_ev_board_pct_depleted` 0/30 | PASS |
| `c4935320` reality-adjusted EV board + edition pack provenance | deploy READY; non-fatal on view error | deploy `3piYzgKk` READY | PASS |
| `ad1aeb5f` trophy-slab label (team+series, badge/serial overlap) + `audit_20260628_trophy_slab_team_series` | deploy READY; no new Sentry | current prod `BKo5NeVs` READY; Sentry 0/24h | PASS |

Vercel: current prod `ad1aeb5f` (`dpl_BKo5NeVsCJRd1V8dJdQtQg5hFrTY`) READY, 0 ERROR. All feature deploys (`7c7ce83a`/`5ee2574`/`ba3b010`/`c4935320`/`ad1aeb5f`) READY; the 4 docs-only commits (`a665dc6e`/`dadf9736`/`bebb1cf8` + the 06-28 monitor/night-pass) correctly CANCELED by the `ignoreCommand`. **0 reverts.**

---

## Health-drift triage (baseline `rpc_ops_snapshot()` @ 08:05Z) — GREEN
- **Security:** invariants [] · anon_write_holes [] · rls_off_base_tables [] · secdef_anon_violations [] → **0/0/0/0**.
- **Trust health:** **13/13 ok**, breaches []. unmapped_resolution_backlog_max 29/100, edition_integrity_flags 4/50, fmv_sanity_flags 0/1, ts_uuid_dupes_created_24h 0/200, pack_ev_board_max_stale_days 0.48/2, pack_ev_board_pct_depleted 0/30, all per-collection `*_fmv_stale_hours` ok (topshot 0.3/6, allday 0.2/12, golazos 0.3/30, ufc 0.1/30, pinnacle 22/30; pinnacle_ask 0.2/3).
- **Pipelines:** `detect_stalled_pipelines()` [] · `get_pipeline_alerts()` [] · `check_pgcron_recent_failures()` = **1** (the serial-fmv-power-model weekly timeout = the candidate; same single weekly failed run will surface every tick until 2026-07-05 — do not re-log). Fails 24h: ~28 across 17 pipelines (wmc-fmv-populate 8, pinnacle-nft-resolver 5, compute-topshot-pack-ev 2, snapshot-pack-asks 2, check-alerts 2, +12 singles incl. fmv-recalc/analytics-smoke) — **every one's latest run is ok=true** (verified the 12 notable; transient connection-pool-saturation / TS-GQL during the backfill wave, all recovered).
- **Sentinel:** TS-UUID-editions-48h = **0**.
- **Editions:** FLAT — TS 17,471 / AllDay 6,191 / Golazos 581 / UFC 518. No writer leak.
- **FMV:** TS HIGH+MED **4,645** (1317+3328, improving from 4,604) / AllDay **905** (251+654, ~flat vs 909) / UFC 15 / Golazos 5. fmv_sanity_flags 0. (Pinnacle FMV in its own `pinnacle_fmv_history` — snapshot `fmv_by_collection` shows `{}` by design; read pinnacle legs in trust_health.)
- **DB size:** 6,525 MB (+134 over ~24h — benign backfill-wave growth; monitor saw 6,434 at 15:12Z).
- **Sentry:** **0 unresolved issues firstSeen -24h.**
- **Vercel runtime errors:** all known-benign classes — connection-pool saturation (clustered at the 11:xx UTC cron-rush, self-healing) + heavy-query statement-timeouts on pack-detail/edition/team pages + dup-key idempotent-upsert noise + a `url.parse` DEP0169 warning. No new crash. The 2 new pack-EV views (`pack_realized_ev`/`pack_lifecycle`) show low-count (3/8) non-fatal-by-design page-query timeouts under contention — pre-existing heavy-pack-detail class, not a regression.
- **Artifacts:** 13 in manifest, all active (matches monitor 15:12Z). None flagged broken; none repaired. The 06-28 view-hardening (anon/auth grant revokes + security_invoker restore) cannot affect artifacts — they read via the service-role MCP (`callMcpTool`), which bypasses RLS/grants. (`rpc-live-health` footer `pinnacle_fmv_snapshots` prose is the carried cosmetic WEEKLY-SURFACE-QA-PROSE item — board SQL already reads `pinnacle_fmv_history`; not worth a ~550-line reinstall unattended.)

**Overnight deltas vs metrics-latest (06-28):** FMV TS H+M 4,604→**4,645** (improving); AllDay 909→**905** (flat); editions FLAT; unmapped 26→**29** (well under 100); DB 6,391→**6,525 MB** (+134, benign); sentinel 0→0; security 0/0/0/0 unchanged; Sentry 0→0.

---

## Investigated → QUEUED (1 NEW): SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT
**[MED · DB-only fn change · not auto-shipped: FMV-adjacent + not in-run-verifiable + zero urgency]**

**What:** pg_cron `rpc-serial-fmv-power-model-weekly` (jobid 6, `0 11 * * 0`, calls `SELECT public.compute_serial_fmv_power_model()`) **FAILED its 2026-06-28 11:00Z tick at exactly 120.0s = "canceling statement due to statement timeout"** — an 8.1s→120s regression in one week (06-21 ran 8.1s "1 row"). Its sibling `rpc-serial-fmv-multipliers-weekly` (jobid 5) **succeeded but jumped 2.7s→78.2s** — so both weekly serial-FMV fits are slowing on the same growth and the multipliers fn will hit the 120s cap within ~1–2 weeks too.

**Root cause (measured this run, read-only):** the cancel fires inside the fit's `latest_fmv` CTE = `SELECT DISTINCT ON (fs.edition_id) ... FROM fmv_snapshots WHERE collection_id=TS ORDER BY edition_id, computed_at DESC`. `EXPLAIN` shows a Merge-Append + Unique over **~437,673** TS `fmv_snapshots` rows (2026 partition), already on the ideal index `(collection_id, edition_id, computed_at DESC)` — so there is **no cheap index fix**; the cost is fundamentally reading all daily-snapshot history (which grows daily). The 8s→120s jump = a week of data growth + 11:00Z cron-rush/backfill-wave I/O contention (the multipliers fit fired concurrently at 11:00:01). Neither fit fn sets an explicit `statement_timeout` (proconfig is `search_path` only), so the 120s session default applies.

**Blast radius:** LOW. `serial_fmv_power_model` / `serial_fmv_multipliers` feed `serial_fmv_estimate` (a serial-premium refinement), NOT core FMV / deal boards / pack-EV. The only effect of the miss is the serial-premium params didn't re-fit this week (immaterial at ≤2-week staleness on a weekly model). **NOT a corruption/incident.**

**Why NOT auto-shipped tonight:** (1) FMV-adjacent fit function (extra caution, per the off-limits FMV class spirit). (2) The only result-identical fix is a `statement_timeout` bump, whose **outcome** (the slow fit actually completing) can't be driven to completion within the MCP execute_sql cancel window during the live 01:00 backfill wave — the real proof is the next weekly tick **2026-07-05 11:00Z**, outside this run. (3) Zero urgency (weekly, 6 days out, LOW blast radius). The disciplined call per the pass rules ("when unsure, queue"; "anything you cannot fully verify as healthy this run → queue") is to QUEUE with a ready fix.

**Option A — minimal, result-identical (recommended; ~30s ship + force-run verify in any calm window):**
```sql
ALTER FUNCTION public.compute_serial_fmv_power_model(uuid,integer,integer,numeric) SET statement_timeout TO '600s';
ALTER FUNCTION public.compute_serial_fmv_multipliers(uuid,integer,numeric,integer) SET statement_timeout TO '600s';
```
(ALTER FUNCTION ... SET adds the GUC to proconfig WITHOUT rewriting the body — zero result change, instantly reversible. Verify by force-running `SELECT compute_serial_fmv_power_model();` in a calm window and confirming it returns a row + `cron.job_run_details` logs `succeeded` on the next tick.)
**Revert A:** `ALTER FUNCTION ... RESET statement_timeout;` (both fns).

**Option B — faster, but a logic change (CC review required — changes results subtly):** constrain `latest_fmv` to a recent window, e.g. `AND fs.computed_at > now() - interval '14 days'`, so the DISTINCT ON reads ~5× fewer rows (~91k) and the fit returns to ~10–20s. Near-identical result because every qualifying edition (HIGH/MEDIUM FMV + a 180-day first/perfect sale) is snapshotted daily, so its latest is always within 14 days — but it IS a logic change to an FMV-adjacent fit, so CC should diff the fitted `serial_fmv_power_model` rows before/after to confirm parity. This is the better durable fix; pair it with Option A's timeout bump as a belt-and-suspenders.

**Target metric to re-check:** `cron.job_run_details` for jobid 6 logs `succeeded` on the 2026-07-05 11:00Z tick (and jobid 5 stays well under 120s).

---

## QUEUED / carried (no other NEW items) — all owned/operator/gated, none night-pass-shippable
WEEKLY-SURFACE-QA-PROSE (rpc-live-health footer `pinnacle_fmv_snapshots` cosmetic string); ALLDAY-V1-UNMAPPED-DRIFT (owned, unresolvable tail); cron→GHA-decouple pt2 (wallet/snapshot families, CC); consolidated remaining-CC-lane handoff; topshot-sales-history-backfill watchlist; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); VERCEL cost family (Pause+$60 cap, ~76% mid-cycle); A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2.

**STEER honored (do not re-flag):** SERIAL-FMV-MULT-CRON cadence is by-design weekly (the NEW finding above is a *different* signal — the fit RAN and TIMED OUT, not a cadence/staleness flag); evm-transfers-ingest Base-429 benign; the TS-Flowty unmapped class is drained not retired (Declined); the studio-platform deep-history program is post-ship-watch-only.

---

## Shipped / Failed / Reverted
- **Shipped (production):** none.
- **Failed / blocked / auto-reverted:** none. No verification failures, no production hard-stop. Quiet green night.
