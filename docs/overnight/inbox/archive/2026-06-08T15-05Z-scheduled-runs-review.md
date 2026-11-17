# Scheduled-runs review + actions — 2026-06-08T15:05Z (Cowork, Trevor-directed)

Reviewed the scheduled runs since the last check. One was already fixed live; one settled a pending decision; one new finding flagged (not auto-fixed — pricing-engine).

## SHIPPED live by Cowork this session (need ledger Shipped-block entries)

1. **CROSS-COLLECTION REFRESH — FIXED.** The daily `rpc-cross-collection-refresh` task had FAILED since 2026-06-05 (`refresh_cross_collection_cohort_step1()` statement-timeout on the MCP path; `/insights/cross-collection` showing 3-day-stale data). Root cause: both step1 and step2 were per-wallet FOR-LOOPs (step1 did ~144 separate 1.59M-row aggregation scans; step2 the same join per cohort wallet). Fixed:
   - `audit_20260608_cohort_step1_set_oriented_rewrite` — step1 → single GROUP BY + HAVING (one pass). Revert: re-CREATE prior per-wallet-loop body.
   - `audit_20260608_wmc_cohort_covering_index` — `idx_wmc_cohort_cover` on `wallet_moments_cache (wallet_address, collection_id) INCLUDE (fmv_usd)` so the aggregate streams instead of heap-scanning (the rewrite alone still timed out; the index was the unlock). Revert: `DROP INDEX IF EXISTS public.idx_wmc_cohort_cover;`
   - `audit_20260608_cohort_step2_set_oriented_rewrite` — step2 → single set-oriented join. Revert: re-CREATE prior body.
   Verified: step1 cohort_size 144, step2 overlap 244, both mats fresh 06-08 14:57/14:58Z (were 06-05); both fns stayed SECDEF service_role-only (no anon/auth EXECUTE). The daily task now completes in seconds.
   NOTE: brief lock-contention blip on wmc during the non-concurrent index build (~14:55Z) — a few wmc-touching pipelines (pack-ev/hydrator/wmc-fmv-populate) logged transient lock/statement timeouts and recovered immediately (all have last_ok ≥14:58Z). One-time, no ongoing damage.

2. (Other migrations this session logged in their own handoffs: `audit_20260608_squeeze_board_suppress_unanchored_low_ask`, `audit_20260608_close_verified_wallet_selfwrite_holes`, `audit_20260608_seed_sets_wnba_skyline_254`.)

## ACTION NEEDED — operator/Trevor

3. **LISTCACHE-V2 — retire it (decision now clear).** The primary `topshot-listing-cache` RECOVERED on its own (ran 14:21Z after the ~9h dropout); `topshot-listing-cache-v2` is now ~16h dead (last 06-07 22:48Z) with ZERO impact, because the primary alone keeps `cached_listings` fresh. -v2 is a redundant duplicate that only ever trailed the primary ~2s. Recommend RETIRE: drop its cron-job.org entry (operator/Chrome) + set its watchlist row `is_active=false` (Cowork can do the DB part on your go-ahead). This also clears the standing `detect_stalled_pipelines()` flag it's been raising.

## FLAGGED — Pinnacle workstream (NOT auto-fixed; pricing-engine + dedicated task owns it)

4. **PINNACLE RENDER FMV RECOMPUTE TIMING OUT — blocks the legacy-table drop (step 3).** `pinnacle-sync`'s `pinnacle_fmv_recalc_render_all()` was CANCELED (statement timeout) on the 10:07Z tick → Pinnacle per-render FMV is stale (`pinnacle_catalog.fmv_computed_at` last 06-07 10:07Z, ~29h) and not refreshing. Same row-by-row class as cross-collection: `_all` is a `FOR each DISTINCT render_id IN pinnacle_sales LOOP` calling the per-render pricer + UPDATE — ~1,794+ renders, heap-bound. **The per-render math (`pinnacle_fmv_recalc_render`) is the FMV engine — review-gated, so I did NOT touch it.** Recommended direction (CC/Trevor): make `_all` INCREMENTAL (only recompute renders with a sale newer than their `fmv_computed_at`) and/or give it a longer `statement_timeout` + server-side execution — orchestration changes that leave the pricing math untouched. The dedicated `pinnacle-sync-tick-verify-jun8` task (ran ~14:50Z) owns the verdict; **the legacy `pinnacle_fmv_snapshots` drop must stay BLOCKED until render FMV refreshes cleanly.**

## CLEAN (no action)
- `rpc-trust-health-watch`: 0 BREACH. `rpc-pending-signups-watch`: 0 pending. Monday weeklies (`rpc-weekly-health-check` 07:36Z, `rpc-weekly-health-report` 10:02Z) ran. Nightly autonomous pass: clean, 0 shipped (NO-PUSH). Set-254 hydrator gap stayed closed.
- Still pending later today (on schedule, nothing to do): daytime-monitor (15:05Z), rewards-pulse (16:03Z), watchlist-pinnacle-crons (16:30Z — note: it may try to watchlist pinnacle-fmv-recalc, which is currently timing out per #4, so that watchlist add should wait), dupe1-gate-notifier (23:00Z), stagger-histogram-verify (8pm).
