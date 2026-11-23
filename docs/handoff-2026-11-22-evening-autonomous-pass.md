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
-7. **CI coverage ratchet back over its floor + HCI non-JSON fix** (`db3a68f04`, CI green 10:53 PM PT). `4df3092c5` failed only the merged statement gate (91.79 vs 91.8; every test passed): the prototype's cert/holdings routes sat at 58%. Route + HCI client tests added (planted defects red); review finding 9 fixed. Local full run 91.84%.
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
- **`atlas_listing_verify_tick` (job 466, 428k blocks/call in pgss)** — that figure is a since-08-12 average. Today: 15.9 s avg / 287 runs / 0 fails (timeout 240 s). Its `edition_offers` step reads ~0.6 s when warm (EXPLAIN of every read part: 156 + 73 + 16 + 20 + 331 ms). The `:X6` ticks run ~2× the `:X1` ones (eo 13.1 s vs 3.0 s at :06/:01). A `pg_stat_activity` sample of the 23:16 tick: 16 of 18 s in `IO/DataFileRead`, **never lock-blocked**. That is cache pressure from what shares `:X6` (`sync_sales_from_atlas`, `rpc-wmc-fmv-reconcile-saved`, the hourly Panini rollup), not a bad plan and not the `:X5` floor-clear's locks. Moving the tick only moves the collision; no harm today.
- **Cadence-collapse "8 stopped"** = the 11-18 Atlas-port retirements (+ the finished mint backfill / label fill); the arm does not score stopped lanes (Pipeline Silence does). Not an alarm.
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
0. **[P1, Cowork, before 4 PM PT 11-23] Retire two cadence bridges** (`pack-pulls-chain-history`, `pinnacle-pack-openers`; both ratio 1.000 vs the 11-24 baseline). The MCP held the DELETE twice; SQL + premise + verify are item 2 of inbox `2026-11-23T0200Z-…-held-delete-stale-challenges-suppression.md`. If not done, the sentinel cadence arm reads WARN from 4 PM PT.
1. ✅ **DONE 11-23 ~3:55 AM PT — Top Shot gate week 2 MET: 11-16 HIGH 83.3 / MEDIUM 73.1** (n 8,093 / 14,096; job 828 ran 3:37 AM PT, 66 s). 2 of 4 weeks; next read Mon 11-30. Health sweep at the same time: 0 medium+ alerts (8 info, Atlas 403 base rate), stalled [], 0 cron failures in 2 h.
2. **[P3, Trevor, 0 nights] Top Shot sales ingest cadence.** A shorter cron-job.org interval for `topshot-sales-indexer` is the remaining drop-day lever now that the hot lane is fixed (lag p50 16 min / p90 53 min; the 11-18 drop lagged ~1 h). It costs one more Vercel invocation per tick, so it is your call.
3. **[P4, Trevor, 0 nights] `topshot-buyer-backfill-historical`** (external scheduler, every 30 min) has re-found the same one undecodable row (`decode_404`, `spork_floor`) on every run since 08-28, with 0 written. Pause it in cron-job.org if you agree; nothing reads its output.
4. ~~[P4] #235 per-minute peak~~ **READ ~11:30 PM PT — stays OPEN:** a 17-region sweep hit ~450–500+/min at 10:10–10:14 PM PT 11-16; every other minute > 400 was our own 1–3-region QA. Next is Trevor/Cowork: did the JA4 `Entity page sweep` rule log or limit it (firewall dashboard only)? Detail in known-issues #235.

## Dated reads
- ✅ **Wrap-up reads 11-23 ~7:20 AM PT:**
  - **Job 704** (`pack-rips-chain-rekey`): 23 runs since 9 PM PT, avg **14.3 s** (max 54 s) vs 28.5 s — **−50 %**; 0 failed, 0 `window_clamped`, every `window_lo` = previous `window_hi` − 5 min.
  - **Hot lane:** **0 stranded** Top Shot editions right after the 7:08 AM PT fmv-recalc run (12 before the fix).
  - **Panini:** `sales_history_unrecognised_keys` = 0 across 2,330 `panini-ingest` runs since 9 PM PT. No hyphen-shape `nft_sales_data` row since the fix because none sold: positive control = 217 such rows in 30 d, newest sold 11-19 1:39 PM PT.
  - **Health:** 0 medium+ alerts (7 info), stalled [], 0 pg_cron failures in 2 h, security invariants clean; prod READY `245f4cb1`; CI green. The two Cowork DELETEs are still pending (2 bridge rows, 1 stale suppression).
- ✅ **Pre-send read 11-23 ~4:15 AM PT (8:33 AM weekly email, first sealed-packs block):** today's `portfolio_snapshots` = 58 rows, 39 with `pack_low_ask_usd > 0` (block shown), 19 at 0 = 14 holding no packs + 5 holding only unlisted packs (no block — the 11-22 steer's 5), 0 NULL. `packWeekFrom` returns null at 0, so no `$0.00` line can render. Post-send check: Resend shows the send, no recipient with `pack_held_count = 0` got a block.
- **11-23:** job 850 `pack-rip-backfill-eligible-refresh` day average vs 37 s; `rows_found` ≈ 38.8k (the set); `rows_written` tens to hundreds.
- **11-23 daytime:** job 704 `pack-rips-chain-rekey` average duration over a full day vs 28.5 s (expect roughly 40 % lower); `extra.window_clamped` false. ↳ **Early read 11:14 PM PT: 6 runs since the cursor, avg 11.6 s (max 16 s), 0 failed — −59 %.**
- **11-23:** `fmv_recalc_hot_editions` stranded count (snapshot newer than sold_at but older than ingested_at, not HIGH/MEDIUM) stays ~0 between runs.
- **Read 11:13 PM PT:** Panini per-run `extra.sales_history_unrecognised_keys` = 0 across 349 `panini-ingest` runs since 9 PM PT.
- **~5:10 PM PT 11-23:** the Sentinel "Panini Ingest" WARN clears once the 82 drops from 11-22 5:09 PM PT leave its 24 h window. Earlier proof: any `panini_sales` row with `source = 'nft_sales_data'` and `edition_external_id` under `packcard-850147_111938_` other than `…_2-6_*`. A new unrecognised shape in the Sentinel sample is a fourth shape: same recipe, measure first.
- **11-24 (from the earlier steer):** the fmv-recalc :08 historical-fallback timeout rate. ↳ **Early read 11-23 ~4:25 AM PT (12 h since job 704 moved):** `:08` 1/16 = **6.3 %** (was 21 %, 16/77), `:28` 0/15, `:48` 0/15 — under the steer's 10 % line; confirm on the full day.

## Closed out 11-23 ~11:15 AM PT (thread archived after this)

- **Handed to Cowork at 7:44 AM PT** (inbox `2026-11-23T1545Z`); **all of it was done by ~8:15 AM PT** (that filing's ✅ section):
  - cadence bridges retired (`20261123154756`);
  - stale challenges suppression dropped (`20261123154821`);
  - #235: the JA4 rule was challenging, not logging (known-issues #235);
  - `check_set_completion(text)` dropped (`20261123154924`);
  - Trevor's two cron-job.org calls made (indexer every 5 min; historical buyer backfill paused).
- **Re-verified live ~10:56 AM PT:**
  - cadence arm `expired_exemptions` = [];
  - `check_set_completion` gone;
  - `topshot-sales-indexer` 12 runs / h on `:X3/:X8`;
  - `topshot-buyer-backfill-historical` 0 runs / h;
  - ownership walk counted the two mega-wallets as `too_large` (0 errors), and they stopped recurring.
- **Shipped ~11 AM PT — `20261123185838`:** jobs 476/474 (Top Shot unmapped-sale resolve + promote) hourly → every 10 min.
  - Why: the 5-min indexer cut lag p50 15.0 → 3.7 min, but p90 stayed ~47 min because every late sale landed at `:54` via the hourly drain.
  - ⚠ **Correction 11:15 AM PT:** `promote_unmapped_sales` enforces a **20-min minimum gap** per collection (`c_min_gap`, 08-30, sized for All Day's 104k backlog), so on the 10-min schedule every other 474 run logs `skipped_recent_run` (rows NULL, honest). Effective drain = **every 20 min** (first real one 11:19 AM PT). Expect p90 ~20–30 min, not ~15. A Top Shot-only gap (its drain is 1–2 s) would be a pinned-function change — not done.
  - ✅ **Positive control 11:21 AM PT:** the first real drain on the new schedule ran at **11:19 AM PT and promoted 20 of 20** eligible parked sales.
  - **Read on 11-24:** Top Shot on-chain p90 ingest lag over a full day should fall toward ~20–30 min. Query in cron-and-schedulers.md, "Split a lag distribution by INGEST MINUTE".
- **Still open, owned elsewhere:**
  - #249 (ISR caches a degraded render): needs a preview-verified segment change.
  - Candy ask-age: a model decision for Trevor or the Candy thread.
  - #235: its exit is now "no > 400/min through ≥ 10 regions for a week".
- **Dated reads that outlive this thread:** in `focus.md` and inbox `2026-11-23T1545Z` §6.
  - Panini Sentinel WARN clears ~5:10 PM PT 11-23.
  - fmv-recalc `:08` full-day rate 11-24.
  - Gate week 3 Mon 11-30.
- **Docs updated at close:**
  - this handoff;
  - `docs/sessions/2026-11.md` (entry + lessons 7–11);
  - `testing-and-ci.md` (coverage ratchet at its floor);
  - `cron-and-schedulers.md` (lag split by ingest minute; lock-vs-IO sampling recipe);
  - `roadmap-status.md` (gate week 2 + the `within_25_pct` unit trap);
  - `strategy/collections/nba-top-shot.md`.

## Decided after archive prep (11-23 ~11:30 → 11:35 AM PT; Trevor: "Figure these out yourself")

- **GHA "stall" (inbox `2026-11-23T1913Z`): triaged, no change.** GitHub is shedding the two probe workflows (Sentinel, Dead Lane Backstop: delivered every 4–8 h), not stopped: 5 other `schedule` runs landed 10:43–11:27 AM PT. Freshness lanes have non-GHA primaries and are on cadence; only two GHA-only historical backfills are paused by it.
- **Candy ask-age: DECIDED keep `last_seen_at`.** The bound means confirmation age by design (as Top Shot's `low_ask_confirmed_at`), and corroboration's ≥ 3-sale leg gates it. 2 of 35 Candy MEDIUMs even have 3 sales / 30 d. The relabel is the real exposure (candy-mlb.md Now 2).
- **#249: CLOSED** by its own exit (0 whole-page failures / 48 h; the burst source is rate-limited). Reopen trigger is in the register.
- **#235: CLOSED** (rule enforcing, Cowork 11-23; no ≥ 10-region sweep since 11-16). The last ~10 h of the week is a focus.md dated read.
- **Top Shot promote gap: decided on a threshold.** The 11-24 p90 read decides (> 20 min → a Top Shot-scoped 5-min gap; else close). focus.md.

## Closed out before archive (11-23 12:16 → 1:15 PM PT; Trevor: "leaving nothing unresolved from this thread")

- **Edition titles: shipped `6c34b6b66`.** A no-player edition whose name IS its set ("NFL Draft — NFL Draft", "Ghost in the Machine — Ghost in the Machine") showed the set twice in title, description and JSON-LD; 356 pages. Live-verified; test `edition-title-does-not-repeat-a-set-subject`.
- **R8: closed.** The 36 All Day editions are draft-pick vouchers (chain read via pg_net → Flow REST, recipe in tooling-gotchas.md). Descriptions written: `20261123202750`.
- **#261: 12,976 pack pulls dated** from `pack_open_pulls` → `pack_rips` (`20261123195151`); 25 left undated. The Dune part stays dated to 12-13.
- **Top Shot promote gap: SHIPPED `20261123210830`** (1:08 PM PT), on the early read (p90 24.8 > 20). Gap per scope (Top Shot 5 min, others 20); jobs 476 `1-59/5`, 474 `3-59/5`. Pin +3 assertions, planted defect caught. **Verify on 11-24:** focus.md steer (expect p90 ≤ ~10). A scheduled task for it could not carry the Supabase connector, so it lives in focus.md for the nightly pass / Cowork.
- **Split-player merge: with Cowork** (inbox `2026-11-23T2145Z`; staged SQL in `docs/proposals/`). Nothing owed here.
- **Nothing else open from this thread.** The register's OPEN rows (R136, R73, E5, R59, R65) and known-issues' 3 open / 1 partial each carry their own gate or date; the dated reads are scheduled tasks (Panini WARN 5:23 PM PT today, fmv-recalc 11-25, gate week 3 11-30, FMV week-2 11-30, Dune items 12-14) plus the 11-24 Top Shot lag in focus.md.

