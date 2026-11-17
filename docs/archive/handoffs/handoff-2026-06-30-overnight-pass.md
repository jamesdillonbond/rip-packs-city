# Nightly autonomous pass — 2026-06-30 (MONITOR-MODE, off-hours ~07:12 PDT, no clock skew)

**Mode:** MONITOR-MODE. Fired late at real **14:12Z / ~07:12 PDT** — outside the 00:00–06:00 quiet-hours window (app-launch trigger, same class as 06-24/25/27). **No clock skew this run:** shell `date -u` 14:12Z == DB `now()` 14:12Z == newest app-stamped `sales.ingested_at` 14:12:19Z (within ~25s). → full triage + post-ship watch, **queued instead of shipped, docs-only commit** (push WAS available). No FREEZE.

**Git:** sandbox clone `$HOME/rpcwork`; origin/main `b9aa7486` at start, unchanged through the run (docs commit appended at close). Push available (dry-run clean).

**Shipped:** 0 production. **Reverted:** 0. **Repaired:** 0 (no artifact broken). **Closed:** 2 (both AllDay EV dist-page timeouts, fixed by daytime Cowork). **Queued:** 1 new (LOW). Drained 4 inbox files.

A quiet, honest monitor-mode night. Value = the independent post-ship watch on the heavy 06-29→06-30 daytime wave + the AllDay-EV-fix reconciliation the 06-30T0610Z monitor asked the night pass to close.

---

## Connector availability (degradation note)
- **Supabase:** available — full health triage + post-ship watch ran DB-side.
- **Vercel + Sentry connectors:** NOT loaded this run; `web_fetch` is provenance-gated (can't fetch arbitrary prod URLs). So no independent live-HTTP / runtime-error / deploy-READY check was possible this run (same wall the 06-27 monitor-mode run hit; the Sentry connector has also been down for the monitor's last 4 ticks). Post-ship watch is therefore **DB-comprehensive but frontend-blind**. Mitigation: the 06-30T0610Z monitor already saw prod `d23f5e66` READY + both AllDay EV timeout classes quiet since 04:03Z; only frontend-additive commits landed after (badges art `9b3cf644`/`0bf99835`, account-value landing `d193778d`, SEO titles `ea5cb40f`/`d23f5e66`). OPERATOR: reconnect the Sentry connector when convenient.

## Section 2 — health triage (GREEN)
Baseline via `rpc_ops_snapshot()` + drilldowns. All values authoritative as of ~14:16Z.

- **Security 0/0/0/0** — snapshot `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`; re-confirmed by direct catalog SQL (`rls_off_base_tables`=0, anon-write-holes-on-RLS-off=0). The `api_probe_debug` scratch table from the 03:11Z smoke candidate is confirmed ABSENT (transient).
- **Trust health 15/15 ok, breaches []** — incl. the 2 Pinnacle metrics from the 06-29 hardening audit (`pinnacle_render_floor_stale_hours` **0.5/30**, `pinnacle_fmv_impossible_flags` 0/3). The render-floor metric proves the new 06-29 intraday floors_only cron is working: it was 17.5h at 03:11Z, now 0.5h.
- **detect_stalled_pipelines() []**, **get_pipeline_alerts()** 2 INFO (golazos_sales 2-in-24h + ufc_sales 1-in-24h resolving_editions, benign), **check_pgcron_recent_failures('24h') []** (SERIAL-FMV-POWER-MODEL-WEEKLY jobid-6 aged out of the 24h window — resurfaces ~07-05, already queued, do not re-log).
- **Sentinel TS-UUID-48h 17** (known inert DQ4 UUID-dupe-writer leak; `ts_uuid_dupes_created_24h` 17/200 ok; 17 << WARN 250 / breach 200; not escalating).
- **Editions real-flat:** TS **17,489** (= 06-29 baseline 17,471 + the 17 inert DQ4 + 1) / AllDay **6,191** / Golazos **581** / UFC **518**. No real writer leak.
- **FMV (direct latest-per-edition):** TS HIGH 1,312 + MEDIUM 3,373 = **4,685** H+M (improving from 06-29 baseline 4,645) / AllDay 263+645 = **908** / UFC 15 / Golazos 5. `fmv_sanity_flags` 0. (Note: the snapshot `fmv_by_collection` coverage accounting reads conservative — cross-check direct when in doubt, per the 03:11Z monitor note.)
- **Pipeline fails 24h:** 12 pipelines with ≥1 fail (pinnacle-nft-resolver 8, wmc-fmv-populate 7, compute-topshot-pack-ev 5, +9 fewer) — but **EVERY one's latest run is ok=true** (verified per-pipeline, all within the last ~51 min). Known transient connection-pool-saturation during the backfill wave; 0 genuine stalls.
- **DB size 7,095 MB** (+570 since the 06-29 baseline 6,525). **Fully explained + benign:** the two NEW pack-market-history tables from the 06-29/06-30 secondary-pack-market surfacing wave dominate it — `topshot_pack_sales_history` 232 MB / 566,509 rows (the `de3531c0` TS-to-2020-genesis backfill, still filling) + `allday_pack_sales_history` 213 MB / 477,814 rows (the `c653e23` AllDay leg) = 445 MB; the rest is normal wmc/fmv/sales daily growth during the wave. Flagged so a future tick doesn't read the rate as an anomaly; the TS table will plateau once it reaches genesis. No action.

## Post-ship regression watch — heavy 06-29→06-30 daytime wave — ALL PASS (DB-side), 0 reverts
Re-measured every shipped change from the last ~24–48h against the metric it was meant to move. Nothing regressing → no auto-revert.

- **AllDay EV dist-page matview fix (`8b4b1872`) — DURABLE, verified.** `mv_allday_pack_ev_corrected` resolves (**2,330 rows**); `v_allday_pack_ev_corrected` is a passthrough (2,330 == 2,330, `security_invoker=on`); the 6h refresh pg_cron `rpc-allday-ev-corrected-refresh` (jobid 28, `23 */6 * * *`) **succeeded twice — 06:23Z + 12:23Z, ~6s each, 0 fails/24h** → matview is fresh (2h), so the dist page reads pre-computed data and the per-request aggregation timeout is structurally impossible. `v_allday_pack_realized_ev` resolves (147 rows, filling: 45→147 since 00:13Z). → **closes both AllDay EV timeout queued items** (see below).
- **AllDay FMV freshness lever (`rpc-allday-listing-ask-fmv`, jobid 19)** — succeeded 1.7h ago, 0 fails/24h. AllDay STALE 347 (healthy churn; the daily 09:40 cron re-floors newly-stale editions to ASK_ONLY).
- **AllDay pack mechanics (jobs 20/21/25 — opens-forward / opens-backfill / sales-backfill)** — all latest `succeeded`, 0 fails/24h.
- **AllDay + TS pack-market surfacing (`c653e23` / `de3531c0`)** — `v_allday_pack_market` 1,164 rows, `v_topshot_pack_market` 1,770 rows, both `security_invoker=on`; backing tables RLS-on (in the snapshot's rls_off=0). Backfilling as designed.
- **Pinnacle intraday render-floor (`105c9e9c`)** — `pinnacle_render_floor_stale_hours` 0.5h (working; was 17.5h pre-cron).
- **All 7 recently-shipped views** (`mv_allday_pack_ev_corrected` + 6 AllDay/TS views) confirmed `security_invoker=on` (or matview n/a) and resolving.
- **Frontend-only commits** (badges art `9b3cf644`/`0bf99835`, account-value landing `d193778d`, SEO titles `ea5cb40f`/`d23f5e66`, moment-FMV→pack-EV read-only `6d86b972`): no DB writer; editions flat confirms no leak. Live deploy-READY of the post-06:10Z commits is **unverified this run** (Vercel connector + web_fetch unavailable) — carried as a note, not a finding; the morning monitor tick will catch any deploy ERROR.

## Cowork artifacts
15 in the manifest, none flagged broken; none repaired (MONITOR-MODE: don't regenerate working artifacts). The monitor validated the highest-blast-radius dashboards healthy at recent ticks (rpc-pack-lifecycle, rpc-live-health, rpc-moment-fmv-ev-dialin 05:22Z, rpc-growth-funnel 04:21Z), and their backing views are confirmed green in this run's snapshot/resolve checks. No 06-30 schema change dropped/renamed anything an artifact reads (the wave was additive). Carried cosmetic: `rpc-live-health` footer still names `pinnacle_fmv_snapshots` in prose (WEEKLY-SURFACE-QA-PROSE) — the board's SQL already reads the right table; a 550-line reinstall for one cosmetic string is the wrong risk trade for an unattended pass.

## Inbox drained (4 files → 3 distinct candidates)
1. **ALLDAY-CORRECTED-EV-DIST-PAGE-TIMEOUT** (21:13Z) → **CLOSED.** Fixed by daytime Cowork `8b4b1872` (matview precompute). Durable-verified above (matview fresh, jobid-28 cron healthy, monitor confirmed the Vercel class quiet since 04:03Z). No re-fix, no re-queue.
2. **ALLDAY-PACK-REALIZED-EV-DIST-PAGE-TIMEOUT** (00:13Z) → **CLOSED.** Same `8b4b1872` fix relieved the page's query budget (realized-ev leg now ~0.2ms; `v_allday_pack_realized_ev` resolves 147 rows); monitor confirmed quiet since 04:03Z.
3. **SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG** (03:11Z) → **QUEUED** (LOW, night-count 1; folds into ANALYTICS-SMOKE-RESIDUAL). Verified clean this run (`api_probe_debug` absent, security 0/0). See Needs-decision.
4. **0610Z reconcile** — the AllDay-EV-fix status change; actioned via closes #1/#2 above. No new candidate.

## Needs decision (queued)
### NEW — SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG (LOW; folds into ANALYTICS-SMOKE-RESIDUAL; CC/operator; night-count 1)
The route smoke test (`app/api/smoke-test/route.ts`) keeps the two security guards (`check_public_security_invariants` / `check_secdef_anon_execute_violations`) HARD (deliberate, ledger Item 6 / audit_20260622 — a guard-RPC error must page), while `analytics_smoke_run()`'s RLS leg was softened for the transient-scratch-table class (audit_20260622_analytics_smoke_transient_falsepos_to_warn). So when an ephemeral RLS-off table appears mid-sweep, the ROUTE smoke test hard-fails (→ Sentry/Telegram page) where analytics_smoke now only warns. `api_probe_debug` is one such ephemeral table — and it has NO source in the repo (grep of .ts/.tsx/.sql/.mjs = 0), so it's created out-of-band (ad-hoc probe / external session). Verified NOT a live hole (table absent, security 0/0). Cost = recurring cry-wolf on the most important smoke leg. **Not auto-shipped:** route-logic change requiring a deploy (push-effecting) + the root cause is an unknown out-of-repo table creator; softening a deliberately-hard security guard deserves a deliberate call, not an unattended monitor-mode ship. **Two fixes (CC):** (a) find what creates `api_probe_debug` without RLS and have it create WITH RLS / in a non-public schema / drop in the same txn; OR (b) mirror the analytics_smoke softening on the route smoke test — exclude known-ephemeral scratch names (`api_probe_debug`, `audit_*`, dedup temps) from the HARD `check_public_security_invariants` leg, while a persistent product-table RLS hole still pages. Verify: the "SMOKE-TEST HARD FAILURES … rls_off_base_table" class goes quiet while a genuine RLS-off product table still hard-fails.

### Carried (unchanged; one-line)
- **SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT** (night-count 2; MED, DB-only fn) — `rpc-serial-fmv-power-model-weekly` jobid-6 timed out 120s on 06-28; next run 2026-07-05; ready fix A `ALTER FUNCTION compute_serial_fmv_power_model(...) / compute_serial_fmv_multipliers(...) SET statement_timeout TO '600s'`. Not auto-shipped: FMV-adjacent + outcome only provable at the 07-05 tick (not drivable in the MCP cancel window). Still queued.
- **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT** (CC route hot-file or DB design call), **BUYERBF-PERINVOCATION-WORK** (CC route + operator cadence), **ALLDAY-V1-UNMAPPED-DRIFT** (owned drain-vs-classify decision), **WEEKLY-SURFACE-QA-PROSE** (cosmetic), **THIN-FMV-GUARD-CONTENTION**, **refresh-conflated-editions cron** (operator), **cron→GHA-decouple pt2** (CC), **topshot-sales-history-backfill watchlist**, **VERCEL cost family**, **A1-WORKER-PASSTHROUGH-CLEANUP**, **PIN-FMV-REKEY-WAVES 2/3**, **PIN-SYNC-CRON**, **P3-BUYERS**, **DUPE1** (gated/CC), **Q2/Q5/Q6**, **N1**, **ANALYTICS-SMOKE-RESIDUAL**, **IPFS ×2**. See ledger.

## Failed / blocked / reverted
None. No shipping attempted (MONITOR-MODE). Nothing regressing → 0 auto-reverts.

## STEER honored (did not re-flag)
DQ4 inert UUID leak (17/200, owned); AllDay pack-mechanics crons / pack-OPEN ingestion (intentional); studio-backfill activity; alerts-dispatch/send; evm-transfers-ingest Base-429 (benign); SERIAL-FMV weekly cadence (by-design); the new Pinnacle floors_only cron (post-ship-watch, now proven). Declined items not re-raised.
