# Overnight autonomous pass — 2026-08-02

**Run:** rpc-nightly-autonomous-pass, GENUINE OVERNIGHT (fired 08:03Z / ~01:03 PDT, inside 00:00–06:00 local).
**Clock check:** shell 08:02Z ≈ DB now() 08:03:15Z ≈ max sale ingested 08:03Z ≈ max fmv 07:56Z — **no skew**, DB/app time authoritative.
**Gates:** lock RELEASED (last night) → took `night-20260802T080336Z`; no FREEZE; push AVAILABLE (`--dry-run` clean); `origin/main` = `33b207e3` at run start (fresh GitHub clone, NOT the split-remote mount — the trap the 08-02 Cowork ledger entry warns about does not apply here). Connectors: Supabase + Sentry + Vercel MCP all live.

## Outcome: SHIPPED 0 · reverted 0 · repaired 0 — correct for a quiet, mildly-saturated night

No clean low-risk shippable candidate existed. The one live actionable breach is the multi-day IOPS-saturation class whose durable fix is heavy, on the hottest table, and unverifiable within a bounded run (QUEUED, not blind-shipped). Every other finding is already-resolved-by-a-recent-CC-fix, known-and-draining, a benign scheduler dropout, or documented deliberate behavior. No recent ship correlates with a regression, so nothing was auto-reverted.

## Post-ship regression watch (last ~24–48h ships) — ALL PASS, 0 reverts
Origin/main moved `6d0cc7e0` (last night) → `33b207e3` on a heavy 08-01 CC/Cowork wave. Re-measured each recent ship's target metric:
- **fmv_sanity_flags** (last night's queued benign FP): **self-cleared 1 → 0**. The TS 261:8714 Champagnie star-set false positive is gone; the queued sanity-view refinement is now moot / lowest priority.
- **opens-history descending-cursor fix** (CC `a3817e14`): holding — **31 ok / 1 fail over last 8h (96.9%)**; the 31 fails/24h in the snapshot is the pre-fix window rolling off. PASS.
- **pack-reality board materialization** (Cowork `358b6850`/`85d3c6cc`, 08-01/02): the 4 legs probe fast now — `topshot_pack_reality_dist` 9ms, `_top_ev` 8ms, `v_topshot_pack_realized_ev` 76ms, `_stats` 10ms. PASS.
- **set-detail graceful timeout** (`6d0cc7e0`, Sentry NEXTJS-22): 0 recurrence in the last 24h. PASS.
- **Candy go-live** (`1a4c77a7`): green — `candy_fmv_stale_hours` 0.1, `candy_sales_stale_hours` 1.8, all candy boards return data.
- **edge-deno → blocking** (`33b207e3`, the prod tip): deploy `dpl_JDWgzjm2…` READY.

## Health-drift triage (rpc_ops_snapshot @ 08:04:40Z)
- **Security:** clean — invariants [], anon_write_holes [], rls_off_base_tables [], secdef_anon_violations [].
- **Trust health: 2 breaches, both non-user-facing.**
  1. **`public_board_slow_count` = 6 (breach_at 1) — NEW tonight, IOPS-saturation class, NOT a regression, NOT auto-shippable.** The liveness probe (recorded 06:58Z) shows 6 boards over their calibrated `max_ms` but **all return data with no errors** (fail-soft: no user-facing outage): `cross_collection_deals_board` 16.7s/15.4s, `candy_holder_board` 12.7s/4.0s (the standout, 3.2×), `allday_scarcity_board` 8.5s/8.3s, `topshot_first_mint_trophy_stats` 7.4s/5.4s, `topshot_first_mint_trophies` 7.0s/6.2s, `candy_special_serials_board` 4.4s/4.1s — 3 of 6 only 2–8% over (threshold noise under any load). **Diagnosed, not guessed:** `EXPLAIN` on `candy_holder_board` shows a total planner cost of only ~4,700 with clean index-only scans (`idx_wmc_candy_holder_cover`, fmv covering indexes) — it is **not missing an index**; its 12.7s is pure IO-contention wait. So an index would not fix it, and the breach is the documented multi-day IOPS-pressure wave (the daytime monitor logged it across the 18:06Z / 21:06Z / 03:06Z ticks) amplified by new Candy read traffic post-07-31-go-live + `sales_YYYY` partition leaf-fragmentation. Not attributable to any single revertable ship → no auto-revert. Durable fix (QUEUED below) is the off-peak sales-partition REINDEX and/or materializing the heaviest board legs (the pattern CC used 08-01/02 for pack-reality) — heavy, on the hot `sales` table during live ingest, benefit unverifiable within one run. Raising `max_ms` thresholds is deliberately NOT done (guard-defeat).
  2. **`unmapped_resolution_backlog_max` = 100 (breach_at 100) — known, draining, info-level.** At the exact threshold (was 87 last night). `get_pipeline_alerts` shows the AllDay/TopShot unmapped lanes draining as designed (nba_top_shot ~0.4d to clear the actionable pile; nfl_all_day 32,708 actionable of 64,192, the rest frozen-by-design multi-NFT txs). Not a fresh stall.
- **pg_cron failures (`check_pgcron_recent_failures`):** 2, both the MV-refresh-timeout-under-contention class — `rpc-refresh-misattrib-candidates` (15:35Z, the already-queued one, 1/1 in window) and `rpc-refresh-allday-pack-realized` (06:35Z, transient 1 of 4 — 3 succeeded). Internal QA/support MVs; stale-by-one-refresh, no public surface. Same IOPS story.
- **Stalled pipelines:** 1 — `classify-acquisitions-multicollection` silent 238 min (threshold 180). **Benign cron-job.org scheduler dropout of a healthy hourly job** — its last 6 real runs are all ok=true (last 04:06Z, 43 rows); the classifier reprocesses a rolling window so missed hours self-heal. Not a code defect, not data loss; not autonomously actionable (cron-job.org console is operator-only). The 3 fails at 19–21:06Z were the documented afternoon nfl_all_day statement-timeout wave. Verify it resumes.
- **Sentry (24h):** 1 new — `JAVASCRIPT-NEXTJS-23` (player-page statement timeout, 1 event / 1 user, ~21:00Z). The documented deliberate entity-page saturation class (`get_player_editions` 161ms warm, structural throw left as an honesty choice). Not a new defect.
- **Vercel:** prod tip `dpl_JDWgzjm2…` (`33b207e3`) READY; no ERROR-state deploys in the last 20 (CANCELED = superseded rapid commits, normal).
- **Sentinel:** TS-UUID-editions-48h leak = 0. **DB size:** 11,730 MB (+148 vs 11,582 last night).

## Inbox drained (4 files, all archived this run)
- `2026-08-01T181526Z` — MISATTRIB-MV-REFRESH-TIMEOUT → folded into the IOPS QUEUE item; the 15:35Z failure is the same one still showing.
- `2026-08-01T210630Z` — SATURATION-WAVE-RECURRED + edition-median MV → same IOPS QUEUE item.
- `2026-08-02T001232Z` — UFC-STUDIO-DRAIN-CRON-SILENT → **CLOSED: already resolved by CC `44e97c34` (08-01)**, which cut the cadence to daily and re-sized the watchlist threshold 90min → 1560min (26h); the monitor read pre-fix state. Did NOT apply the monitor's suggested DELETE — it would revert CC's deliberate same-day decision (they kept the row active at 26h/medium to preserve a genuine total-stop signal). The drain resumed at 06:00Z; with the 26h threshold it is correctly not stalled.
- `2026-08-02T031223Z` — misattrib recurrence re-justifying the sales-partition REINDEX → folded into the IOPS QUEUE item.

## Queued (nothing auto-shipped)
- **PUBLIC-BOARD-SLOW / IOPS-REINDEX (night 1 as a board breach; the underlying REINDEX is ledger item ~7739, deferred).** Durable lever for the recurring MV-refresh timeouts + `public_board_slow_count` breach: an off-peak `REINDEX INDEX CONCURRENTLY` sweep of the 7 `sales_YYYY` partitions' `*_collection_id_sold_at_idx` (61–71% leaf-fragmented), and/or materialize the heaviest board legs (`candy_holder_board`, the two `topshot_first_mint_*` trophy boards, `cross_collection_deals_board`) behind their published names like CC did for pack-reality. NOT auto-shipped: heavy IO on the hot `sales` table during live ingest, a REINDEX failure leaves an INVALID `_ccnew` index, and the benefit (board timings) is confounded by contention so it is unverifiable within a bounded overnight run. Ready form per index (standalone, NOT in a txn): `REINDEX INDEX CONCURRENTLY public.sales_2026_collection_id_sold_at_idx;` (repeat per partition). Operator/CC call.
- **OPENS-HISTORY rate/ETA signal (night 1).** CC's `a3817e14` made the cursor advance with `ok=true`, so `cursor_stalled` + fail-rate alarms can no longer fire for it — it needs a backfill-rate/ETA arm on `v_rpc_trust_health` (CC flagged this). Monitoring build, not a blind ship.
- **Carried:** GHA-ACTIVE-LISTINGS-INGEST-DROPOUT (standing egress-block class, `topshot-active-listings-ingest` 50%/2d, GHA lane disabled-by-design, healthy neighbors within ~1–2h → live coverage intact); the standing queue (edge-orchestration testing, non-wave wallet-backfill driver, DUNE seller-recovery inert, chain-two gated). The last night's SANITY-VIEW-STAR-SET-FP item is effectively moot now that fmv_sanity_flags self-cleared to 0.

## Failed / blocked / reverted
None. Nothing shipped, nothing failed, nothing reverted.
