# Overnight pass handoff — 2026-07-18

**Mode: OFF-HOURS / MONITOR-MODE (stale-sandbox trap) + concurrent-active → shipped 0 (correct), queued, docs-only.**

## Run frame / why monitor-mode

The pass fired against a sandbox whose **VM clock + initial Supabase connection were frozen ~7h stale** at ~08:0xZ (the documented 07-06-class trap). The clock-skew guard passed *falsely* on the first reads because all three sources shared the frozen clock:
- Shell `date -u` **08:02:36Z** ≈ first DB `now()` **08:02:52Z** ≈ first `max(sales.ingested_at)` **07:56Z** — internally consistent, so no skew detected.

Ground truth from independent signals proved the frame was stale:
- A **fresh** DB `now()` re-read returned **2026-07-18 15:22:09Z** (max sale 15:12Z, max fmv 15:17Z, newest cron run 15:22Z) — the connection had caught up after the first ~2 queries.
- `origin/main` advanced **7 commits** during setup (`3d913bd9` → `2cc5dacc`), commit-stamped 08:05–08:19 **PDT** (= 15:05–15:19Z).
- The daytime monitor pushed a **first-tick-of-day** inbox `2026-07-18T1513Z` (its own "~08:06 PDT" + DB now() 15:07Z, sales flowing).

**Real local time ≈ 08:22 PDT (Saturday morning) — OUTSIDE the 00:00–06:00 window.** Two independent queue-only conditions therefore applied: (1) OFF-HOURS, and (2) a **concurrent CC/Trevor session actively pushing** all morning (UX/perf/cron commits through 08:13 PDT, including on the pinnacle-sync pipeline). → **shipped 0, queued everything, docs-only.** Push AVAILABLE, no FREEZE.

Note: my first `rpc_ops_snapshot` (generated_at 08:04:46Z) was from the stale connection — health below is the **re-read at 15:23:40Z** (live).

## Health-drift triage (live 15:23Z)

- **Security 0/0/0/0** — invariants / anon_write_holes / rls_off_base / secdef_anon_violations all `[]`. Clean after the full 07-18 CC DDL wave (insights_hub_stats single-scan, split_weekly_db_maintenance, prune_stale_wmc 600s).
- **Trust health: 1 BREACH.** `topshot_impossible_parallel_serials` **27 / breach 3** — the known **self-healing WNBA `::`-cataloging class** (re-accumulated from 1 on 07-17 as new `::` subeditions were cataloged with floor-seeded circ below real sale serials). Bigger wave than usual (27). Non-autonomous: cleared only by a **sanctioned interactive/Trevor circ floor-raise** (data-mutation on the guarded `editions` table) — QUEUED. All other 14 metrics ok.
- **`pinnacle_fmv_stale_hours` 29.3 / breach 30** — ~0.7h from breaching. `stalled_pipelines = [pinnacle-sync]` (silent 1756 min; missed its 07-18 10:07Z daily tick = cron-job.org trigger dropout, the recurring external class). QUEUED with a ready DB-only fix (below).
- **`stalled_pipelines`**: `[pinnacle-sync]` only. **pg_cron failures `[]`.** **sentinel_ts_uuid_editions_48h 0** (fossils aged out of the window). **fmv_sanity 0.**
- **pipeline_fails_24h** (all known/benign): topshot-moments-hydrator 9 (upstream GetMintedMoment, self-limiting), compute-topshot-pack-ev 7 (pool-timeout under contention), fmv-recalc 2, populate-pinnacle-wmc-fmv 2, drain-conflated-subeditions 1, + assorted singles. `stalled_pipelines` confirms none silently stopped. (The 177 topshot-atlas-pool-ingest fails from 07-17 have aged out.)
- **editions**: TS 19,429 (+4 :: benign) / AllDay 6,190 / Golazos 575 / UFC 518 / **candy_mlb 125** (Candy Drop-1 discovery, expected per CLAUDE.md). **DB 9,878 MB** (+~233 vs 07-17 9,645, benign :: / studio-history / candy churn).
- **FMV TS H+M** 965 + 2,384 = **3,349** (continuing the benign sales-cooldown redistribution the 1513Z monitor confirmed: 07-12→14 sales spike aging out of the 7/30d windows + Saturday dip; tracked-set size stable ~19,325, freshness green, no methodology change → internal tier redistribution, not data loss). Confirm-only.
- **Sentry: 0 new unresolved / 24h (production).** **Vercel prod `b14f4376` READY, 0 ERROR-state** (newer 995055de/2cc5dacc are the normal CANCELED ignored-build-step for DB/docs pushes).

## Post-ship regression watch — ALL PASS, 0 reverts

- **07-17 read-diet throttles (jobs 71/72/75/76)** — PASS. `backfill_topshot_historical_pack_ev` (71, hourly), `backfill_null_serial_sales_from_moments` (76), `rollup_allday_rip_pull_value` (72), `sync_allday_pack_dist_totals` (75): **0 fails/26h, latest all `succeeded`**; `pack_ev_board_max_stale_days` **0.53 < 2** confirms the 6× jobid-71 throttle did NOT stale the pack-EV board.
- **07-17 CC DDL wave** (get_lock_check_batch index rewrite, analytics_sales_summary single-scan, impossible-parallel wave-4 clear, offers-raise 600s, lock-check skip-locked) — HOLDING: security 0/0/0/0 after the wave; lock-check-batch/analytics-smoke no longer in the fail set; pg_cron failures `[]`. (impossible_parallel re-accumulating to 27 is the self-healing `::` class re-cataloging, NOT a regression of the wave-4 clear.)
- **07-18 concurrent CC wave** (b14f4376 market/UFC UX, 995055de insights_hub single-scan, 8ceca936 pinnacle-sync after(), 1199a873 weekly-maintenance split + prune_stale_wmc, c5fa9886 cache s-maxage, 62308eab Pinnacle Market, 6b19e387 launch-QA, IA reorg) — landed minutes-to-hours ago (real time); **this is the next night pass's post-ship-watch target**, not meaningfully watchable same-hour. Verified only that **security invariants are clean after its DDL** and Vercel/Sentry show no ERROR/new-issue. The 1513Z monitor already did a first-pass watch (no artifact-breaking DROP/rename; security 0/0/0/0).

## Artifacts

17 in the manifest. Their HTML lives on `C:\Users\TDill\Claude\Artifacts\…` which is **not mounted** in this sandbox (only rip-packs-city / outputs / uploads) — cannot repair from here (same limitation prior passes noted). None needed: the **1513Z monitor validated `rpc-live-health`** this cycle (all 12 /insights backing views return rows; FMV/Pack-EV/offers freshness live) + `rpc-panini-squeeze` backing views, and **no schema DROP/rename shipped 07-18** (ships were route/cron/cache/UX + additive DB), so nothing drifted the estate.

## Shipped

**None** (correct — off-hours monitor-mode + a concurrent CC session actively pushing, including on the exact pipeline of the lead finding). A quiet, honest morning: the sandbox fired stale, the trap was caught, full read-only triage + post-ship watch ran clean, actionable items queued for the active session.

## Queued (needs decision / owner action)

1. **PINNACLE-SYNC-FMV-STALE (HIGH / imminent, NEW tonight — DB-only ready fix; owner: CC/operator, who is actively on this pipeline).** `pinnacle-sync` missed its 07-18 10:07Z daily tick (cron-job.org trigger dropout — the recurring external class); `pinnacle_fmv_stale_hours` **29.3/30**, ~0.7h from breaching. **Ready fix (~15s, clears the breach now):** `SELECT pinnacle_fmv_recalc_render_all();` (confirmed 0-arg SECDEF; the exact leg the daily route runs; renders ~2,095). **Not fired:** monitor-mode + the CC session is actively on pinnacle-sync (`8ceca936` after()-fix deployed 14:44Z) — reaching into that pipeline's recompute concurrently is the collision the rules forbid. **Self-heals** at the 07-19 10:07Z tick (now after()-fixed so it won't 30s-timeout) if the cron fires; the ready command clears it sooner. Operator can also inspect the cron-job.org "RPC Pinnacle Sync" history from ~10:07Z.
2. **IMPOSSIBLE-PARALLEL-27 (trust BREACH, self-healing class — interactive/Trevor/CC, non-autonomous).** `topshot_impossible_parallel_serials` 27/3: newly-cataloged WNBA `::` subeditions floor-seeded with circ below a real sale serial. Same class cleared by waves 1–4 via `audit_*_circ_floor_raise_*` (raise circ = max observed serial per edition; snapshot table + reversible UPDATE). Non-autonomous (guarded `editions` mutation, sales-adjacent). The per-parallel circ backfill self-reconciles over time; a Trevor/CC circ floor-raise clears it immediately if wanted before it self-heals.
3. **PINNACLE-MINT-ACQ-STATEMENT-TIMEOUT (LOW, from 0620Z inbox — DB-only ready fix; self-recovered).** pg_cron job 85 `rpc-backfill-pinnacle-mint-acquisitions` (`19 * * * *`, `SELECT public.backfill_pinnacle_mint_acquisitions(50000)`) failed 1/26 at 05:19Z (statement timeout); currently `check_pgcron_recent_failures()` `[]` (latest tick ok, self-recovered). The fn carries `statement_timeout=90s` explicitly. **Ready fix if it recurs:** `ALTER FUNCTION public.backfill_pinnacle_mint_acquisitions(integer) SET statement_timeout='600s';` (pure pg_cron SELECT, no HTTP/after()-lambda kill-trap — the proven offers-raise/serial-fmv 600s pattern). **Revert:** `ALTER FUNCTION … RESET statement_timeout;`. **Not shipped:** monitor-mode + self-recovered (marginal preventive value) + concurrent-active DB session. Target metric: job 85 absent from `check_pgcron_recent_failures()`.
4. **DRAIN-CONFLATED-SUBEDITIONS-FINAL-STEP-TIMEOUT (LOW, from 0007Z inbox — CC/owner, route-logic).** `drain-conflated-subeditions` (daily 20:30Z orchestrator, `app/api/admin/drain-conflated-subeditions/route.ts`) perpetually logs ok=false: a late orchestrator step (guard re-measure / trailing seed-realign) exceeds statement_timeout AFTER the substantive de-conflation commits (07-17: wmc_split 329 / sales_split 6 / moments_realigned 99). No trust breach; background data-hygiene, no user impact. **Not autonomous:** the route re-keys wmc/moments/sales editions (off-limits ingest-adjacent class); fix = raise the tail step's statement_timeout / cut its batch / move the 20:30Z cron off the contention window — an owner/CC edit to a sales-touching route.

**Standing carried (unchanged, one-line):** V-MOMENTS-NEEDING-HYDRATION (IOPS, structural incremental-queue, deliberate-owner); PINNACLE-SALES-BACKFILL-SPORK-FLOOR (CC/operator, false-severity, cursor parked at spork floor); PINNACLE-GRAIN-MIGRATION Phase 2+ (Trevor/CC, character-lossy reads); topshot-moments-hydrator GetMintedMoment upstream errors (self-limiting); allday-pack-opens-404 (operator/floor-override); cron-job.org dropout family (operator, self-healing — tonight's pinnacle-sync miss is an instance); chain-two/Candy (gated; candy_mlb inactive by design). LOCK-CHECK-BATCH-DEADLOCK-UPTICK — CLOSING (CC's 07-17 skip-locked write-back held; not in the fail set now).

## Failed / blocked / reverted

None. No shipping attempted (monitor-mode), so no verification failures and no hard-stop.

## Continuity

Drained + archived 5 inbox files (07-17T1510Z, 07-17T2113Z, 07-18T0007Z, 07-18T0620Z, 07-18T1513Z) → `inbox/archive/`. Ledger + metrics-latest.json updated. `.lock` released.
