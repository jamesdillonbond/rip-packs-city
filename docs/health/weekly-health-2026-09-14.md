# RPC weekly health check — 2026-09-14 (PT)

> ⛔ **Flag 1 is CLOSED. Flags 2–5 stand. Committed 2026-09-14 ~08:05 AM PT.** `topshot_impossible_parallel_serials = 36` was repaired the same morning (**#82 RESOLVED**): **37 sales + 643 wmc rows** re-keyed to base; the metric **reads 0** (precompute 07:14 AM PT, re-read live at commit time). This report's own asked-for confirmation — *"confirm the 09-13 restores fully cleared and nothing is re-introducing them"* — was answered the right way round: **the two inflow write points were guarded first and the count watched flat across ~40 ticks**, because a repair run against an open inflow is a refill. ⚠ **Its successor is open and is not the same defect: #116** — the metric is parallel-scoped, so **0 hides 1,727 base-edition** `sales` rows.
>
> ℹ **Two health documents carry today's date, written by two different tasks. They are not duplicates.** This file is the Monday `rpc-weekly-health-check` **operational** sweep (pipeline failure rates, DB size, rewards economy, traction). [`PROJECT_HEALTH_2026-09-14.md`](PROJECT_HEALTH_2026-09-14.md) is the weekly **project-health** snapshot (numbered register, go-live bars, recommended sequence) and is the file that continues the twenty-report `PROJECT_HEALTH_*` series named in [session-and-archive-conventions.md](../reference/session-and-archive-conventions.md). Where a figure differs, both are dated samples taken hours apart — **re-derive, do not reconcile.**

**Status: NEEDS ATTENTION.** No outage, users unaffected, 24h pipeline success 99.1%. But one trust-health breach (Top Shot impossible parallel serials = 36 vs bar 3), Top Shot pack-EV is 88% stale, and the DB is 30.5 GB — 13 GB of it the known pg_net `_http_response` high-water mark (#75).

## This week
- **Pipeline failures (7d leaders):** sales-counterparty-backfill 256/870, pinnacle-nft-resolver 85/820, lock-check-batch 51/144 — all statement/upstream-timeout class (known, transient, self-retrying). `sync-nba-projections` 21/24 (87.5%) is nearly all-failing on a tiny run count — worth a look.
- **24h pipeline success:** 99.1% (19,423 runs, 172 errors) — within the ~99% baseline. ✓
- **Silent degradation (48h, ok + 0 rows):** nothing alarming — every 0-row pipeline is a heartbeat, sentinel, resolver-with-nothing-to-do, or a caught-up backfill. ✓
- **pg_cron failures (3b):** 3 heavy weekly/rekey jobs timed out **2026-09-13** — `rpc-serial-fmv-power-model-weekly`, `rpc-serial-fmv-jersey-weekly`, `rpc-topshot-onchain-rekey` (all `statement timeout`). Recent (yesterday) and won't retry until their next weekly tick. Flagged below.
- **Pack EV freshness:** AllDay 3,130 packs / 425 stale-3d (~14%, fine). **Top Shot 1,210 packs / 1,061 stale-3d (~88%)** — newest row is today, but the bulk is >3 days old, consistent with the `pack_distributions` "last seen 11 days ago" alert. Flagged.
- **DB size:** **30,561 MB (~30.5 GB)** — well over the ~5.5 GB flag. Driver is `_http_response` (pg_net) at **13 GB**; then `wallet_moments_cache` 2.8 GB, `pack_rips` 2.0 GB, `sales_2026` 1.4 GB. The 13 GB is the known #75 high-water mark (decided 09-13: no VACUUM FULL; re-measure 2026-09-20). Flagged.
- **FMV:** all freshness legs OK (topshot_fmv_stale_hours 0). HIGH-confidence ≈ **1,424** (TS 1,309 + AllDay 115) — above the 400 bar. TS MEDIUM 6,458. `v_fmv_sanity_flags` = **0 rows**. ✓
- **Security / RLS drift:** 0 RLS-off base tables, 0 anon write-holes, 0 SECDEF-anon violations. ✓
- **Traction:** concierge 7d = **4** (smoke-filtered), outbound_clicks 7d = **1** (non-zero, watch), email_subscribers = **0**, portfolio_snaps 7d = **142** (healthy). Still well below the 50-WAU gate.
- **Bloat:** `_http_response` 13 GB is the only >500 MB anomaly, and it is the known #75 item. No new rogue schema/table.

## Flags
1. **TRUST-HEALTH BREACH — `topshot_impossible_parallel_serials` = 36 (bar 3).** F1 parallel mis-attribution: Top Shot sales keyed onto `::parallel` editions with serial > parallel circulation. Sits in the exact area actively worked 09-13 (parallel-downgrade-restore, the unguarded-rekey fix). The 36 is above threshold and invisible to the flat/UUID/FMV sentinels by design — this needs eyes to confirm the 09-13 restores fully cleared and nothing is re-introducing them.
2. **Top Shot pack EV ~88% stale (1,061/1,210 >3d)** + `pack_distributions` data-stale 11 days. AllDay is fine. The TS pack-EV feed is not being refreshed.
3. **3 weekly pg_cron jobs timed out 09-13** (serial-fmv power-model, serial-fmv jersey, topshot-onchain-rekey) — heavy analytical jobs hitting the 120 s wall; they won't self-heal until next week.
4. **DB 30.5 GB / `_http_response` 13 GB** — known #75, decided not to reclaim; falsifiable re-measure due **2026-09-20** (≈13 GB ⇒ reuse working, close #75; materially larger ⇒ reclaim/retention justified).
5. **`sync-nba-projections` 21/24 fails (7d)** — small pipeline failing almost every run.

## Rewards
- **Economy:** 17 participants · 10,495 credits issued · 250 spent · **10,245 outstanding** · 1 redemption fulfilled, **0 pending**.
- **7d activity:** 30 ledger rows, 620 issued, 0 spent, 5 active users (dial-in phase — Trevor's testing).
- **Verification funnel:** 9 wallets verified total; **0 challenges minted/passed/expired** this week (no friction because no attempts).
- **ACTION ITEMS:** none — no pending redemptions, nothing stuck >3d.
- **RED FLAGS:** none — no negative balances, no stuck pendings. `scout_wallet` earn counts (243/46/38/24) are the expected program mechanic, not anomalies.
- **Readiness:** behaving correctly; still dial-in. Warm enough to keep tuning; no push to users.

## Autonomous changes — confirm or roll back
This week was **exceptionally high-volume** — 100+ ledger entries across nightly-pass, Cowork, and Claude Code cloud sessions (the bulk dated 09-11 → 09-13), nearly all CI- or production-verified. Notable classes: honesty fixes (failed-read-as-fact across wallet search, sniper feed, pack-EV coverage, OG cards), the parallel-serial downgrade/restore data work, sentinel arm additions, query-plan/index perf fixes, and the #75 pg_net decision. Multiple self-corrections/retractions were made and resolved **in-session**; I found **no open auto-reverts** left dangling. Per-item revert paths are recorded inline in `docs/overnight/ledger.md` — given the count, I have not reproduced all here. **Reply with any you want rolled back** and I'll pull its exact revert command.

## Stale queue — forced decisions
No fresh ledger "Queued" backlog older than 7 nights — this week's items were drained same-session. Standing operator-only blockers carried (need Trevor, agent cannot do them):
- **#22 credential-purge residue** — deleted branch's blobs still fetchable by SHA until GitHub GCs; ask GitHub to GC + **rotate the exposed cred regardless**. → RE-DATE (external: GitHub GC) or SHIP the rotation.
- **#55 two 2-hourly Routines disabled** — no approval card exists; re-verified still disabled. → needs your re-enable decision.
- **#8 ESPN sports-proxy 403** — measured dead. → DECLINE (move to "Declined — do not re-suggest") unless you want it re-attempted.
- **Sentry** — dark since 08-18, browser SDK off; decided no-spend. → confirm DECLINE.

Reply with a verdict per item — anything without a verdict carries another week and will be re-asked.
