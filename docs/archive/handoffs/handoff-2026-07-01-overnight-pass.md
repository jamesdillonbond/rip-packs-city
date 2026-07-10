# RPC nightly autonomous pass — 2026-07-01 (GENUINE OVERNIGHT, 01:03 PDT, no clock skew)

**Mode:** genuine overnight (in-window). **Shipped 0** (correct — the one real candidate has no clean/safe fully-verifiable fix; see below). **Reverted 0 · repaired 0 · closed 0.** Post-ship watch on the heavy 06-30 badge-art/perf/jersey-FMV/insight-links wave = **ALL PASS, 0 reverts**. Drained 3 inbox files. **Queued 1 (sharpened):** CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT — measured to disprove the monitor's suggested pure-timeout ALTER (route `maxDuration=120` coupling makes it unsafe).

## Run context / gates
- **Clock-skew check (no skew):** shell `date -u` 08:02:50Z ≈ DB `now()` 08:03:51Z ≈ newest app-stamped rows (`max(sales.ingested_at)` 08:03:13Z, `max(fmv.computed_at)` 07:58Z). Real local time ≈ **01:03 PDT — inside 00:00–06:00** → genuine overnight, normal shipping allowed.
- **Lock:** mount `.lock` was RELEASED (stale ~15h, Cowork 06-30T23:43Z). Took it: `ACTIVE 2026-07-01T08:03Z run=20260701T080309Z-20247`. Released at end.
- **FREEZE:** none. **Push:** available (`git push --dry-run` = "Everything up-to-date"). Sandbox clone `$HOME/rpcwork`; origin/main **`811ac094`** unchanged start→end (re-fetched before writing — no collision).
- **Connectors:** Supabase ✓, Vercel ✓ (deploys + runtime-errors). Sentry connector not separately loaded — used Vercel `get_runtime_errors` as the frontend-error proxy (comprehensive, 50 groups/24h). Cowork artifact tools ✓.

## Section 2 — health-drift triage (GREEN)
Baseline via `rpc_ops_snapshot()`:
- **security 0/0/0/0** — invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all `[]`.
- **trust_health 15/15 ok, breaches `[]`** — incl. offer_edition_gap_max_usd back to 0 (the 03:38Z transient self-cleared), unmapped_resolution_backlog_max 29/100, fmv_sanity_flags 0, all per-collection fmv_stale_hours ok, pinnacle_fmv_stale_hours 22/30.
- **detect_stalled_pipelines() `[]`** · **check_pgcron_recent_failures() `[]`** · **get_pipeline_alerts()** 2 INFO (golazos_sales + ufc_sales resolving_editions, benign/long-standing).
- **sentinel TS-UUID-editions-48h 17** (inert DQ4 leak, < warn 250).
- **editions FLAT** — TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518 (identical to 06-30 baseline; no writer leak).
- **FMV per-edition (direct):** TS HIGH+MED **4,679** (1306+3373; was 4,685 06-30 — flat), AllDay **911** (255+656; was 908 — flat/slightly improving), UFC 15, Golazos 5. Pinnacle FMV lives in `pinnacle_fmv_history` (snapshot `fmv_by_collection` `{}` by design; its trust legs all ok).
- **pipeline_runs 24h fails:** 15 pipelines (pinnacle-nft-resolver 7, wmc-fmv-populate 6, classify-acquisitions-multicollection 5, compute-topshot-pack-ev 3, check-alerts 3, offers-sweep 3, +9 fewer). **Verified all 14 non-classify pipelines have latest-run ok=true** (within ~1h) — every fail transient/recovered (known connection-pool-saturation during the backfill wave). classify is the queued item.
- **DB size 6,992 MB** — was 7,095 (06-30 baseline); **−103 MB** = overnight prune/vacuum, benign (monitor saw the same dip to 6,977–6,982 mid-night).
- **Vercel:** prod **`705fb202` READY** ("perf(edition): bundle insight-links into one RPC"); **no ERROR-state deploys** in the last 20 (all CANCELED = docs/monitor/ledger commits correctly caught by the docs-only ignoreCommand). Runtime errors 24h = only the KNOWN families (DBSAT/connection-pool cost family, `url.parse` DEP0169 warning, idempotent `wmc_wallet_moment_unique_idx` upsert conflicts, AllDay-corrected-EV collateral, per-query statement timeouts) — **no new class attributable to any 06-30 commit**.

## Post-ship regression watch — 06-30 wave — ALL PASS, 0 reverts
The heavy 06-30 daytime/evening wave (`db9ef2b6`→`811ac094`; current prod `705fb202`): badge-art CDN restore (0944535f/e8e52f43/kyGse4L/0c70791b/3ce52b04/63929d11 + Trevor), warmup/perf (01aeacf9/09de1589/e46249eb/39407539), jersey-FMV refit + caller swap (4c5963e8/00b802d9/957c41cb), pack-dist EV panel (9b619fb8), insight-links RPC bundle (705fb202), React #418 freshness-chip fix (8f167a66).
- **No data regression:** editions FLAT (no writer leak from any presentational/badge/warmup change); FMV flat + `fmv_sanity_flags` 0 (the jersey model refit onto `editions.jersey_number` did NOT corrupt FMV).
- **New DB objects present + correctly secured** (verified via pg_proc): `compute_serial_fmv_jersey_model` (SECDEF, service_role+postgres only); `get_edition_insight_links` (SECDEF, anon/authenticated/service_role — anon-read of already-public squeeze/deals/first-mint boards, consistent + `secdef_anon_violations []`); the new **7-arg** `serial_fmv_estimate` jersey overload correctly scoped **service_role+postgres only** (not anon-exposed; the public 6-arg overload unchanged).
- **Perf wave working as intended:** the edition-page connection-pool-saturation errors (`get_edition_detail`/`sales`/`special_serials`/`high_offer`/etc. "Timed out acquiring connection from connection pool") last occurred on the **superseded** `dpl_8Gu4` at 06-30T22:06–22:11Z — they are **not recurring on current prod `705fb202`**. Dropping the dead `special_serials` query + bundling the 3 insight-link reads into one RPC + Suspense-streaming player Top Sales is measurably reducing edition-page fan-out (the connection-pool driver).
- **AllDay-corrected-EV dist-page timeouts** (`allday_corrected_ev`, 27/24h) — known DBSAT collateral per the 06-30 close; the matview passthrough itself is ~8ms (monitor re-verified). **Do NOT reopen ALLDAY-CORRECTED-EV.**

## Artifacts
15 in manifest; **none flagged broken** by tonight's 3 monitor ticks (all validated the shared backing DB layer as resolving/healthy). Fresh-on-open + not sandbox-reachable (OneDrive) + not broken → **no repair** (regenerating working artifacts is discouraged). Cosmetic WEEKLY-SURFACE-QA-PROSE (rpc-live-health footer `pinnacle_fmv_snapshots` prose string) stays **carried, not repaired** — a 550-line full-file reinstall for one stale prose string is the wrong risk trade for an unattended pass, and the board's actual query already reads the live table.

## Shipped
None. Correct outcome: platform GREEN, the entire 06-30 wave verified PASS, and the sole new candidate (classify AllDay timeout) has no clean/safe/fully-verifiable low-risk lever this run (below). Quiet honest night; value = the independent post-ship watch + a measurement that disproved the monitor's proposed fix.

## Queued — NEW (1, sharpened)
### CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT · [LOW-MED · CC/operator — NOT a clean DB-only ship] · night-count 1 (monitor-escalated across 3 ticks tonight)
**Symptom.** `classify-acquisitions-multicollection` (hourly at :06) — the `nfl_all_day` leg fails `canceling statement due to statement timeout`. 24h: 5 fails / ~40% of ticks (00:06 / 01:06 / 02:06 / 06:06Z at ~95s + 22:06Z at 185s), recovering on the rest (03:06 68.7s / 04:06 75.4s / 05:06 74.6s / 07:06 64.1s). **Flaps, does not stall** (`detect_stalled_pipelines()` []). LOW impact — acquisition classification (`moment_acquisitions` enrichment), NOT FMV / deal boards / pack-EV / any user-facing surface; a failed tick classifies 0 that hour and the next passing tick resumes.

**Mechanism (measured, authoritative).** The route (`app/api/cron/classify-acquisitions-multicollection/route.ts`, last touched 2026-06-09 — NOT a hot file) calls SECDEF `backfill_acquisitions_for_collection(uuid, p_limit)` per collection; AllDay `p_limit=300`. The function's own proconfig sets **`statement_timeout=90s`** (→ the ~95s observed cancels). Its candidate query is a **Merge Anti Join** of ~246k priced AllDay `sales` (`collection_id` filtered inline off the per-partition `sales_YYYY_nft_id_idx`) against 582k `moment_acquisitions` (Index Only Scan on `idx_moment_acquisitions_nft_id`), then a semi-join to `wallet_moments_cache` (`idx_wmc_moment_collection`), `LIMIT 300`. Classic anti-join + LIMIT-scans-deep: the planner underestimates (cost ~21k vs real ~90s).

**Why it stepped up + won't self-resolve.** AllDay `sales` grew to **256,788** priced rows, of which **226,165** are studio-history backfill (`source='allday_studio_history_v1'`, still filling — last ok 06:52Z). Only **28,762** are classified (~2,209 in 24h). AllDay wmc is huge (325,981 moments > the sales count), so `EXISTS(wmc)` is NOT selective — most studio rows ARE classifiable, so the real backlog is ~228k and growing. The leg stepped from ~20s (through 06-30 16:06Z) to 45–95s from 17:06Z on, and will keep flapping (and worsening) as studio fills.

**Why NOT auto-shipped (all levers carry a trade-off needing human judgment):**
- **Pure `statement_timeout` ALTER (the monitor's suggestion) is UNSAFE here.** The route does all work in `after()` under `maxDuration=120`, and the AllDay leg already consumes up to ~95s of that budget. Raising the fn timeout lets AllDay eat more of the 120s → on a contention spike (the 185s class) the whole `after()` lambda is silently killed BEFORE `log_pipeline_run` writes — converting a *visible* flap into an *invisible* no-log failure (the exact 06-20 REFRESH-SPECIAL-SERIAL-OWNERS-MV anti-pattern). A "safe" bump to ~100–105s buys only ~10s and still fails the spikes while adding silent-kill risk. Net negative for observability.
- **No missing index.** All needed indexes exist (`idx_moment_acquisitions_nft_id`, `idx_wmc_moment_collection`, per-partition `sales_YYYY_collection_id_sold_at_idx`). A `sales(collection_id, nft_id)` composite would let the merge read AllDay-only rows in nft_id order (likely the real speedup) BUT it **taxes the hot `sales`-ingest path** with write-amplification to help a LOW-value enrichment cron, and needs a multi-partition CONCURRENTLY build validated by EXPLAIN ANALYZE — an architectural trade-off + attended index build, not a clean single-statement overnight ship.
- **Route change** (reduce AllDay `p_limit` 300→~120, OR coordinated fn `statement_timeout`↑ + route `maxDuration`↑) is a code deploy on a 202+`after()` cron route (the documented invisible-failure class). Reducing p_limit is arguably the cleanest fix and may even *raise* net throughput (fewer 0-classified failing ticks) — but it's a behavioral change to a cron and belongs to CC with a diff.

**Recommended fix (ranked, for CC/operator):**
1. **Route: reduce AllDay `p_limit` 300 → 120–150** (one constant in `TARGETS`). Leg fits comfortably under 90s; stops the flapping; net classified/day likely rises (currently ~40% of ticks classify 0). Revert: restore 300.
2. **Coordinated timeout+maxDuration:** fn `statement_timeout` 90s→150s AND route `maxDuration` 120→200 (≤800 cap) together, so the leg can finish without silent-kill. Papers over an O(N)-growing cost.
3. **Long-term / product call:** whether backfilling acquisition records for ~228k historical studio AllDay sales is even desired; if yes, an index on `sales(collection_id, nft_id)` or a wmc-driven candidate query, EXPLAIN-ANALYZE-validated.
Re-measure over 24h; if it stops recurring on its own (contention-only), downgrade/close.

## Queued — carried (unchanged this run)
SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG (LOW, folds into ANALYTICS-SMOKE-RESIDUAL); SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (night-count 2, resurfaces 07-05 — ready `ALTER FUNCTION … SET statement_timeout '600s'`); REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT; BUYERBF-PERINVOCATION-WORK; ALLDAY-V1-UNMAPPED-DRIFT (owned); WEEKLY-SURFACE-QA-PROSE; THIN-FMV-GUARD-CONTENTION; refresh-conflated-editions cron (operator); topshot-sales-history-backfill watchlist; VERCEL cost family (on-demand cap ~early July); A1-WORKER-PASSTHROUGH-CLEANUP; PIN-FMV-REKEY-WAVES 2/3; PIN-SYNC-CRON; P3-BUYERS; DUPE1 (gated/CC); Q2/Q5/Q6; N1; ANALYTICS-SMOKE-RESIDUAL; IPFS ×2. **STEER honored:** SERIAL-FMV weekly cadence by design; evm-429 benign; DQ4 inert UUID leak; studio-backfill volume expected (do NOT flag). Declined section not re-raised.

## Failed / blocked / reverted
None.

## Inbox drained (3)
- `2026-07-01T001716Z.md` (06-30 ~17:06 PDT) — GREEN; candidate CLASSIFY-ACQ-ALLDAY (night-count 1).
- `2026-07-01T034615Z.md` (06-30 ~20:38 PDT) — GREEN; sharpened classify to night-count 2; offer-gap transient self-cleared (non-finding).
- `2026-07-01T061308Z.md` (06-30 ~23:07 PDT) — GREEN; 12-tick classify history → volume-creep, refined fix to DB-only-lever (which this pass measured to be unsafe due to maxDuration coupling).
All archived to `docs/overnight/inbox/archive/`.
