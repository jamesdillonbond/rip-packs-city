# Overnight pass handoff — 2026-07-10

**MODE: OFF-HOURS / MONITOR-MODE** (fired ~20:41 PDT Jul 9, outside the 00:00–06:00 window). Full triage + post-ship watch; **queued instead of shipped**; docs-only commit. NO clock skew (shell 03:41Z ≈ DB now() 03:41:40Z ≈ newest sale ingested 03:32Z / fmv 03:40Z — app rows can't be future-stamped). Push AVAILABLE. No FREEZE.

Shipped **0** production changes (off-hours; nothing regressing to auto-revert). Reverted 0, repaired 0, closed 0. Drained 3 inbox files. Value this run = independent post-ship watch of the recent concierge ships + health verification + 2 new LOW findings queued.

## Continuity / collision
- origin/main was `187669ed` at clone; it advanced by ONE docs commit `8c2f48d0` ("docs(ledger): log 2026-07-08 concierge check_wallet truth fixes") ~2 min after clone — the daytime Cowork session wrapping up its ledger log. Monitor-mode + docs-only, so no collision risk; rebased before the output commit.
- No code file has a commit in the last 24–48h except the OFF-LIMITS concierge route `app/api/support-chat/route.ts` (187669ed, 07-09 20:40) — not touched.

## Post-ship watch — recent concierge ships: PASS, 0 reverts
- **`187669ed` (07-09 20:40, `fix(concierge): per-tool timeout budget`)** — prod deploy `dpl_GPgKyi2YLm6ZMKyEUEYc1Q5nWJb8` READY. Wallet tools (check_wallet / check_wallet_squeeze) now race a 20s budget vs the blanket 6s that raced them out under DB contention; all other tools keep 6s. Non-destructive timeout raise.
- **`eeff0b1a` (07-07 21:23, `fix(concierge): check_wallet full portfolio + wallet-search rejects unknown collection slugs`)** — prod deploy READY.
- **Evidence:** `get_runtime_errors(/api/support-chat, 40h)` = NONE; Sentry `is:unresolved` last 24h = **0 issues**; support-chat route not in `pipeline_fails_24h`. No regression signal on the concierge path. Both PASS.
- Vercel: prod = `187669ed` READY. Trailing `8c2f48d0` docs deploy CANCELED by the docs ignoreCommand (correct). No ERROR-state deploy in the last 20.

## Health-drift findings (baseline `rpc_ops_snapshot()` @ 03:42Z)
- **Security 0/0/0/0** (invariants / secdef_anon / rls_off_base / anon_write_holes all []).
- **`stalled_pipelines` []** — the 07-08 03:08Z monitor's PINNACLE-RECONCILE-CRON-DROP self-healed (pinnacle_ask_stale_hours back to 0.1h). The 07-07 CRONJOB-ORG-TRIGGER-DROPOUT window also fully recovered (21:06Z monitor closure holds).
- **trust: 16 metrics, 1 BREACH** — `topshot_impossible_parallel_serials` = **4** (breach_at 3). CONFIRMED the known self-healing `::`-cataloging class: all 4 are `::` subeditions cataloged 06-20/06-21 whose floor-seeded `circulation_count` sits below a real sale serial (e.g. `118:4134::8` circ=1 vs sale serial #9; `223:7518::20`, `224:7680::21`, `224:7684::21`). The per-parallel circulation backfill (GQL authoritative circ) hasn't reconciled these 4 stragglers. Not corruption, not a writer leak (sentinel TS-UUID-48h **0**), self-resolves as the circ backfill covers them (same class self-resolved 3→1 on 07-06). Track only.
- **`check_pgcron_recent_failures()`** — 1: `rpc-fmv-clamp-disconnected-ask` failed its 07-09 13:55Z DAILY tick at statement timeout (13:55Z contention window). This is the FMV disconnected-ASK clamp BACKSTOP (jobid 34); the primary clamp runs INLINE on every fmv-recalc (P1b, 07-03), so no user-facing gap. Retries 07-10 13:55Z. DAYTIME-CONTENTION family, LOW.
- **`pipeline_fails_24h`** — NEW elevated family `topshot-moments-hydrator` **31 fails/24h**. Root: upstream `Error with GetMintedMoment` GQL errors on a subset of moment nft_ids; the pipeline alternates ok=true (resolves 100/tick, e.g. 03:12Z) / ok=false (a tick whose 300-candidate window is dominated by upstream-erroring moments resolves 0). `stubs_created:0`, `edition_resolution_failures:0`, `graphql_failures:0` → NO corruption, NOT stalled (`detect_stalled` []), NO writer leak. Moment→edition enrichment only. LOW; track. All other fail families (fmv-recalc 12, compute-topshot-pack-ev 6, wallet-backfill-ufc 6, etc.) are the known overnight/DBSAT-contention class with latest run ok=true.
- **Sentry** — 0 unresolved issues in 24h.
- **Overnight deltas** (vs 07-07 metrics-latest): editions TS **19,088** (+937 = ongoing 07-07/08 `::` subedition cataloging wave; sentinel 0 confirms no hyphen-UUID leak) / AllDay 6,190 / Golazos 575 / UFC 518 (all flat). FMV TS HIGH+MED **5,173** (1424+3749; improving from 4,948) / AllDay 809 / UFC 15 / Golazos 4. DB **8,869 MB** (+502 = `::` cataloging + backfills, benign). unmapped_resolution_backlog 34 (ok). pinnacle_fmv_stale 17.6h (ok). ufc_sales resolving_editions INFO (benign standing).

## Queued (nothing shipped — off-hours; all track/operator/CC)
1. **TOPSHOT-MOMENTS-HYDRATOR-GETMINTEDMOMENT-ERRORS (NEW, LOW, night-count 1; CC/track).** 31 fails/24h from upstream GetMintedMoment GQL errors on a subset of moment nft_ids. Not corruption/stall/leak; resolves 100/tick when the candidate window is clean. NOT auto-shipped: it's the moment-resolution/ingest path (off-limits invisible-failure class) and it's self-limiting. WATCH: if it degrades to persistent 0-resolution across many consecutive ticks, a stuck head-of-queue of permanently-unresolvable moments (retired/erroring nft_ids) wants a CC fix to de-prioritize or quarantine them so the hydrator makes forward progress. No safe DB-only lever.
2. **FMV-CLAMP-DISCONNECTED-ASK-CONTENTION-TIMEOUT (NEW, LOW, folds into DAYTIME-CONTENTION).** Daily backstop cron jobid 34 (`rpc-fmv-clamp-disconnected-ask`, 13:55Z) timed out its 07-09 tick under 13:55Z contention. Inline clamp on every fmv-recalc covers the function, so no user impact. Retries 07-10 13:55Z. If it fails multiple consecutive daily ticks, CC gives the fn a raised `statement_timeout` or bounds its `latest` CTE (NOT a naive bump — measure first per the 07-01 pattern).
3. **TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS-BREACH (4/3, recurring self-healing).** The 4 `::` stragglers above. Self-resolves via the per-parallel circulation backfill. Track; do NOT hand-edit circulation on a sales-adjacent table.

## Carried (unchanged; operator / owned / gated)
- CRONJOB-ORG-TRIGGER-DROPOUT family (operator; recurring, self-heals on cron-job.org recovery — recovered from both the 07-07 and 07-08 instances this window).
- ULTIMATE-FMV-RECALC-V1-MISSED-TICK, SALES-SERIAL-BACKFILL-WATCHLIST, CROSS-SOURCE-DEDUP-STATEMENT-TIMEOUT, BADGE-CATALOG-STALE-429, DAYTIME-CONTENTION-CLUSTERS-BROADENING, DAILY-PORTFOLIO-SNAPSHOT-GATEWAY-TIMEOUT, CLASSIFY-ACQ-ALLDAY, FMV-RECALC-EDITION-FETCH-TIMEOUT-CREEP, REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT, BUYERBF-PERINVOCATION-WORK, ALLDAY-V1-UNMAPPED-DRIFT, WEEKLY-SURFACE-QA-PROSE, THIN-FMV-GUARD-CONTENTION, refresh-conflated-editions cron, VERCEL cost family, PIN-FMV-REKEY-WAVES 2/3, PIN-SYNC-CRON, P3-BUYERS, DUPE1, Q2/Q5/Q6, N1, ANALYTICS-SMOKE-RESIDUAL, IPFS ×2, SMOKE-SECURITY-GUARD-TRANSIENT-API-PROBE-DEBUG.

## Failed / reverted
None. No shipping attempted (off-hours). No regressions to revert.
