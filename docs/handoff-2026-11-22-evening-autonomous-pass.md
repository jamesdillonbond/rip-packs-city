# Evening autonomous pass — 2026-11-22 (~7:40 PM PT →, Claude Code cloud)

**Verdict: GREEN · 6 DB changes + 1 code fix + copy shipped and verified on production runs · 0 reverted · oldest routed: Top Shot gate week-2 read (overnight item 4), 1 night.**

Trevor: "work autonomously for the next 12 hours … find things to work on. Fix any issues you encounter." Push worked from this cloud session (dry-run exit 0); everything below is on `main`, and each item has a ledger entry with its revert path.

## Health (read ~7:40–8:00 PM PT)
- `detect_stalled_pipelines` empty · `check_when_others_timeout_blind` 0 · `check_zero_yield_lanes` 0 offenders (423 inspected).
- Two non-info alerts, both stale. `candy-chain-sales` failure_rate pools the 11–12 AM PT runs from before the fix; every run since 12:11 PM PT is ok. `pg_net_http_400` was the earlier session's 6:18 PM pg_net probe of the two mega-wallets (code 1110). It ages out of the 2 h window.
- Cron failures in 24 h: 3, all already fixed (job 901 COMMIT, job 914 SET clause).
- Vercel 24 h: the smoke `rls_off_base_table:scratch_backfill_pk_trevor` is gone (0 RLS-off public tables live). The rest are section timeouts (set activity, pack-detail panels under a 2 AM PT crawl burst, one collection-snapshot).
- Client-error beacon: **positive control passed.** I threw one error in a headless browser on `/nba-top-shot/market`, and a `client_error` row landed within seconds. So 0 real client errors in 7 days is a true reading.
- Accuracy (`fmv_sales_backtest`, 7 d). Top Shot published ALL: 12.5 % MdAPE, 74.7 % within ±25 %, ratio 1.000 (last-3: 13.3 / 72.7). All Day: 16.0 / 62.9 / 1.000 (last-3: 15.4 / 66.5). The All Day LOW gap is a population mismatch, not a regression: paired weekly LOW reads 44 → 44 → 48 %. Golazos 14 d (n 188): 67.6 % within, ratio 1.20, 168 of 188 at ASK_ONLY. Candy 14 d (n 149): 40.3 % within.
- Top Shot gate (`fmv_accuracy_weekly`, HIGH / MEDIUM within ±25 %): wk 10-26 74.3 / 69.1 · 11-02 75.5 / 69.7 · **11-09 80.1 / 74.1**. That is 1 qualifying week so far; the 11-16 row lands Monday.

## Shipped (newest first)
-6. **Physical-cards prototype review** (`4df3092c5`; the feature is off by default). No high-severity security issue. Fixed the clearly-safe one: an all-unpriced portfolio totalled $0 and now totals null. The other 8 latent findings are in `docs/physical/review-2026-11-22-prototype.md` for that thread; the top one is that eBay listings can be served past their 6 h licence window.
-5. **Pack-rip backfill queue refresh (job 850) writes only changed rows** (`20261123060419`, pin E1–E3). It rewrote all ~38.8k rows every 2 h to record ~30 changes (876k buffers/call). Verified on its first run at 10:14 PM PT: 26.6 s (avg 37 s), 733 rows written. `rows_written` now means rows written.
-4. **Tooling:** the pre-push preflight (`--quick`) now runs the ~50 migration guards whenever a migration changed (`36c64056e`). Before, a migration push was only parsed locally, which is how the next item reached `main` with a stale pin.
-3. **Guard:** a new migration may not match a wallet through a bare `lower(p_wallet)` (`e24de4758`, forward-only, inline escape `-- solana-lower: flow-only`). ⚠ **`main` CI was red ~9:15 → ~9:25 PM PT** (`4582e1cfa`…`5b9a8dfe1`): `export_wallet_csv` was pinned in `acquisition_reads_are_collection_scoped.sql` and I had not re-pinned it. Fixed in `9bee6e27c` (green), with a Solana assertion the old body fails.
-2. **Profile collection breakdown + account CSV export read Solana (Candy) wallets** (`20261123051216`). Both lowercased the wallet, so a base58 Candy wallet read as holding nothing. Verified on the live route: the one saved Candy wallet now shows 575 moments / $474.49. The breakdown is also planned per wallet (3.1 s → 0.22 s, 405k → 40.6k buffers on a 47k-moment wallet), and the export reads `edition_fmv_current` instead of scanning all ~3.2M snapshots. Both were proved equivalent on Flow wallets first.
-1. **Panini sales ingest accepts hyphenated `packcard-` keys** (`20261123045852`; TS mirror + test in `2e90d7d19`). The Sentinel WARNed on 82 sales dropped in 24 h for product 850147/111938 (`packcard-850147_111938_2-2_5_21_79`). The 27 affected editions had 0 stored sales and no edition mixes shapes; 499 serial last-sales were seeded. Every panini-ingest run since reads 0 unrecognised keys.
0. **Candy buyer-paid: a later node's clean "not found" supersedes an earlier node's RPC error** (`516d53b5f`, 2 tests, the first fails on the old code). This closes review finding (b) below before it could turn the lane permanently red.
1. **Lane budget: finished backfill `rpc-topshot-pack-opens-history` (job 56) paused** — `20261123044343`. Its cursor has been at its floor since ~08-01: 10,972 runs and 0 rows ever, 96 edge invocations a day. The watchlist row is inactive (backed up). Active jobs 319 → 318.
2. **fmv-recalc hot lane now re-asks an edition whose newest sale was INGESTED after its latest snapshot** (`20261123041110`, new pin `supabase/tests/fmv_recalc_hot_editions.sql`). The selector compared against `sold_at` only. A snapshot written between a sale's print and its ingest (10–60 min later) hid that sale until the next full sweep. 12 editions were stranded at 8:05 PM PT. **Verified on the 8:28 PM run:** all 12 were re-priced (Golazos #349 / #317 ASK_ONLY $0.90 → LOW $0.17 against $0.20 sales). This is also why the 11-18 WNBA drop priced ~1 h late (strategy-2026-11-22 Move 1 item 2, now split).
3. **`rekey_pack_rips_to_chain_identity()` reads its identity window from a cursor** (`20261123035939`, pin K5). Job 704 probed each identity twice: ~28.5 s/run, ~23 DB-min/day, 3–19 rows/day. **Verified:** the 8:03 run wrote the cursor, and the 8:39 run read a 41-minute window, ok, in 16.1 s.
4. **Copy:** the Golazos registry pitch drops "581 editions tracked, dual-source listing sweep" (575 live; Flowty retired 10-30). Deployed READY.
5. **Docs:** marked closed on live reads — `nfl-all-day.md` #192 / #213 / Flowty teardown, `nba-top-shot.md` #181, and the Candy per-mint trust baseline (0.2 / 0.3 %, replacing the 57.1 % quote). #235 Tencent half: 30 allowed / 2,308 challenged over 11-15 → 11-22.

## Measured, no change (so nobody re-chases them)
- **Candy ask-age** (`candy-mlb.md` "the ask counts as fresh because it is re-seen") is a model decision, not a defect: does a months-old but live ask corroborate? Left for Trevor or the Candy thread.
- **#249** (ISR caches a degraded render): still needs a preview-verified segment change. Tonight's sweep saw the same section-level shape only.
- **`get_set_activity`** (#252 watch): 12 timeouts in 7 d (was 21). The tail is the cold 5,000-row first pass under load (holo-icon 0.27–0.5 s warm). No change.
- **`get_collection_breakdown`**: ✅ fixed later in the pass (shipped item −2).
- **`candy_fmv_pct_stale_30d` = 0.0** is correct by construction: it counts snapshots older than 30 days, not STALE confidence.
- **Review of 4 recent commits** (`e90a0f2a6`, `5d8337121`, `07c53a4d0`, `d182d2ba2`): no high-confidence bugs. Two medium findings are not live today:
  - (a) panini-ingest's sku→id map read has no `.order()`. It only matters if two rows share a sku; today `1065` carries no `pack_sku`.
  - (b) `lib/candy/sale-buyer-paid.ts` `fetchTx` turned "publicnode errored, mainnet-beta returned null" into an `rpc_errors` count. ✅ Fixed anyway (`516d53b5f`). The lane was 288/288 ok in 24 h.
- **Edition-key joins without a collection scope** (CLAUDE.md #142 class): a sweep of live functions joining `editions.external_id = <x>.edition_key` found every one scoped except `check_set_completion`. It has zero callers (code, SQL, cron, pg_stat_statements), so it is a drop candidate for an attended session; a DROP is held by the connector.
- **Other wallet functions:** `get_wallet_moments_with_fmv` is already `force_custom_plan` and Solana-aware. `get_top_movers` takes 3.1 s / 78k buffers on the 47k-moment wallet after its 11-20 rework, inside its 24 s budget. `get_fmv_for_editions` averages 690 ms on 500-id chunks. No change to any of them.
- **`/api/analytics/sales/leaderboard`:** 5 statement timeouts in 4 days; 1.4 s mean, ~30 s tail on long windows. It shows an honest error; the lever is a precompute, not tonight.
- **Pinnacle sniper feed** (errored 11-18/19 on 16–31 h old listings): healthy, refreshed 4.3 h ago against a 13 h limit.
- **Whole-set rewrite scan** (`rows_written ≈ rows_found`, large, every run): besides job 850 (fixed), `allday-lock-refresh` stamps every row of a wallet by design (the per-row 7-day lock promise, already cut to once a wallet per day on 10-04), and `allday-storefront-reconcile` re-confirms every live listing (`verified_at` gates the ask lanes). MV refreshers count their view. No change.
- **`refresh_wmc_fmv_changed` timeouts** (8 of 583 in 48 h) come from the 5-minute route's call under PostgREST's 30 s cap. pg_cron job 303 drains the same cursor (median 0.4 s) and picks up after a killed call. No change.
- **#258 watch:** still empty (10:45 PM PT).
- **Second sweep:** 250 random pages at 2 workers, 0 issues; 40 OG images, 39 image/200 and 1 Pinnacle redirect to Disney's asset host, which this sandbox cannot reach.
- **Live-page sweep** (335 URLs, sitemap 0 + 150 random): 0 NaN/undefined/[object Object]. The only failures were 3 profile collection-breakdown timeouts under my 6-way concurrency.
- **Top Shot sales ingest lag:** on-chain p50 15.7 min, p90 53 min. Driven by cron-job.org every 20 min (:03/:23/:43) plus the :50 GHA backstop.

## Queued for Trevor / Claude Code
1. **[P2, Claude Code, 1 night] Top Shot gate week 2** — unchanged from the overnight handoff item 4: read Mon 11-23 after ~3:37 AM PT.
2. **[P3, Trevor, 0 nights] Top Shot sales ingest cadence.** A shorter cron-job.org interval for `topshot-sales-indexer` is the remaining drop-day lever now that the hot lane is fixed (lag p50 16 min / p90 53 min; the 11-18 drop lagged ~1 h). It costs one more Vercel invocation per tick, so it is your call.
3. **[P4, Trevor, 0 nights] `topshot-buyer-backfill-historical`** (external scheduler, every 30 min) has re-found the same one undecodable row (`decode_404`, `spork_floor`) on every run since 08-28, with 0 written. Pause it in cron-job.org if you agree; nothing reads its output.
4. **[P4, Claude Code, 0 nights] #235 per-minute peak:** one read of the max requests/minute over a week; close #235 if no minute exceeds 400.

## Dated reads
- **11-23:** job 850 `pack-rip-backfill-eligible-refresh` day average vs 37 s; `rows_found` ≈ 38.8k (the set); `rows_written` tens to hundreds.
- **11-23 daytime:** job 704 `pack-rips-chain-rekey` average duration over a full day vs 28.5 s (expect roughly 40 % lower); `extra.window_clamped` false.
- **11-23:** `fmv_recalc_hot_editions` stranded count (snapshot newer than sold_at but older than ingested_at, not HIGH/MEDIUM) stays ~0 between runs.
- **~5:10 PM PT 11-23:** the Sentinel "Panini Ingest" WARN clears once the 82 drops from 11-22 5:09 PM PT leave its 24 h window. Earlier proof: any `panini_sales` row with `source = 'nft_sales_data'` and `edition_external_id` under `packcard-850147_111938_` other than `…_2-6_*`. A new unrecognised shape in the Sentinel sample is a fourth shape: same recipe, measure first.
- **11-24 (from the earlier steer):** the fmv-recalc :08 historical-fallback timeout rate.
