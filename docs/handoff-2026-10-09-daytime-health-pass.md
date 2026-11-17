# Handoff — 2026-10-09 daytime health pass (Claude Code cloud, ~12:45–3:45 PM PT)

Trevor: "do a health check and audit of the entire platform … fix any issues you encounter … work autonomously for the next 3 hours." Push-capable (`git push --dry-run origin main` exit 0); everything below is committed to `main`. A concurrent Claude Code session was active on #173 and the chain-arrival follow-up the whole time, so neither was touched here.

## ▶ RESUME HERE (written 10-09 ~4:15 PM PT; Trevor travelling, back at his PC 10-10)

**State at hand-off:** everything below is on `main`, CI green, deploys READY. Health GREEN: security 0, stalled lanes only the one false alarm below, zero-yield offenders 0, pg_cron failures 0. The one trust breach (`public_board_slow_count`) is the cold Panini status view.

**Do first, in order:**
0. **Second pick-up file from the concurrent Claude Code thread:** `docs/handoff-2026-10-09-claude-code-afternoon.md`. It holds a second HELD prod write (#175: 3 Wembanyama Diced sales re-keyed to `152:5370`, block + revert in its §2) and the 10-10 watches for chain-arrival (4:41 AM) and #173 (after the 1:30 PM drain).
1. **Apply the TWO HELD SQL files (needs Trevor, ~2 min).** Paste each whole file into the Supabase SQL editor: (a) `supabase/migrations/20261009233000_audit_20261009_golazos_sentinel_silence_sized_to_its_volume.sql`. Trevor decided 10-09 ~4:20 PM PT to raise Golazos's sentinel silence limit 168 h → 504 h; 180 d data: 518 sales, p99 gap 112 h, worst 463 h. This clears the hourly sentinel WARN. Verify `silence_hours = 504`. (b) `supabase/migrations/20261009230500_audit_20261009_cadence_watchlist_follows_todays_schedule_changes.sql`. It retires the `ingest-pinnacle-mints-backfill` cadence row (now a false "silent" stall alarm, since its job was deactivated) and tightens `pinnacle-fmv-recalc` to 400/800 min for the 3-hourly schedule. The MCP confirmation gate held it (60 s timeout, nothing landed). Both UPDATEs are guarded, so a second paste is a no-op. Verify: `detect_stalled_pipelines()` no longer lists `ingest-pinnacle-mints-backfill`.
2. **Close #169** if none of the 34 frozen editions still reads MEDIUM on a pre-10-04 snapshot after ~4 PM PT 10-10. They become eligible for the 7-day re-snapshot at ~2:48 PM PT. Query + close-condition + falsifier: known-issues #169, the 10-09 "EXIT RE-MEASURED" note. Close it, re-run `npm run docs:issues-index` (diff before `git add`), add a ledger entry, push.
3. **Confirm panini-ingest reads the whole catalogue.** In Vercel logs, no `hit maxPages=20` after 10-09 1:05 PM PT, and the runner's log line shows `complete=true`. At 4 PM PT 10-09 the runner was walking (sentinel: last walk 0.0 h) but had not re-requested walk-order since the deploy.
4. **Watch items** (each should read as below):
   - `allday-storefront-reconcile`: `ok=true`, `sellers_walk_errors 0`.
   - `pinnacle-fmv-recalc`: ~8 runs/day.
   - `pinnacle-pull-chain`: ~144 runs/day.
   - jobid 84: still inactive.
   - `check_zero_yield_lanes()`: offenders [].
   - `analytics_smoke_run` `freshness_fmv_per_collection`: ok.

**Decisions for Trevor (nothing changed):**
- ~~**Golazos:**~~ ✅ DECIDED 10-09 ~4:20 PM PT (Trevor): raise the silence limit; the SQL is held, see item 1(a). ~~0 sales for 184 h. It is genuinely silent on chain: 0 Withdraw/Deposit events in a 5,000-block sample, while 5,875 listings sit live. That alone keeps the hourly sentinel at WARN ("Golazos … >168h!"). Choose one: mark Golazos closed in `lib/market-closed.ts` (changes its public pages), raise its silence ceiling in `sentinel_ingest_watch`, or leave the WARN as the honest signal.~~
- **`public_board_slow_count`:** the only lever is materialising `panini_sale_feed_status` (a cold 2.4M-row index-only scan behind a rarely visited board).

**Housekeeping:** a self check-in (`trig_01LUjGCHUVv9BbNnwueooHAP`, 10-10 4:15 PM PT) fires into the ORIGINAL thread (session_01V7wSyjqNm8RwtFjxMMGUDR) with items 2–4 above. If you resume in a new thread, do them there and delete that routine, or let it run; it is idempotent.

**Where else this session is recorded:**
- ledger: the 10-09 entries tagged "daytime health pass"
- session log: `docs/sessions/2026-10.md`, top entry
- lessons promoted to cron-and-schedulers.md (watchlist follows schedule), apis-and-cadence.md (page whole-account Cadence scripts) and database.md (paged-reader ceilings)

## Health verdict — GREEN, with three real defects found and fixed

| instrument | reading |
|---|---|
| `check_public_security_invariants()` | 0 rows |
| `v_rpc_trust_health` | 37 ok / 1 BREACH (`public_board_slow_count = 1`, see below) |
| `detect_stalled_pipelines()` | [] |
| `check_when_others_timeout_blind()` | 0 |
| `check_zero_yield_lanes()` | 6 offenders → **0** (all six re-derived as finished work, migration below) |
| pg_cron 24 h | 21 failed / 28,394. All 21 are `rpc-chain-arrival-pack-pulls`, at or before 9:41 AM PT. 3/3 ok since the 10 AM fix (0.07–0.10 s). |
| Vercel 5xx, last 12 h | panini-ingest `maxPages` (fixed below) + 1 pack-drops timeout. The 24 h `pack-detail … read exceeded 5000ms` cluster was ONE burst at 3:00–3:21 PM PT 10-08: ~6 errors per page across ~19 unrelated pages. There was no DB event (no migrations; all cron OK), so it reads as a crawler fan-out and every panel degraded honestly. |
| client-error beacon 24 h | 4, all `Lightpanda/1.0` (already tagged `automated` by design) |
| `get_advisors` security | 0 ERROR. The two public `search_path` WARNs are the COMMIT procedures database.md says must NOT be pinned; the anon-SECDEF WARNs are allowlisted. |
| alerts | `atlas-edition-supply` 64% failure_rate is POOLED across this morning's fix: 4/4 ok since. Atlas 403 arms are info-level and attributed. |

**Accuracy (the gate), published FMV vs what collectors paid, 7 d:** Top Shot median abs err **12.0 %** (HIGH 8.7 %), ratio 1.000, n 15,500 · All Day **21.6 %**, ratio 1.000, n 3,957 · Pinnacle (hand-built: each sale vs the render's last `pinnacle_fmv_history` row before it) **10.0 %**, ratio 1.000, n 1,289. No drift. ASK_ONLY over-reads sales in both Flow sports: TS ratio 1.364 (n 141), AD 1.690 (n 66). That is the known ask-vs-clearing gap, small in dollars (median $2.30 / $0.80).

**Gate metric (`rpc_trust_health_precompute`, 12:48 PM PT), HIGH/MED share of latest FMV rows:** Top Shot **57.2 %** (39.2 % on 08-27, the decided all-rows denominator; 75.0 % of those fresh in 24 h) · All Day 26.6 % · Pinnacle 31.6 % · Candy 22.4 % · Golazos 1.0 % (a silent market, re-verified on chain at 2:35 PM PT: 0 `Golazos.Withdraw` / `Deposit` events vs 31 `AllDay.Withdraw` over the same 5,000 blocks; last Golazos sale 10-01, while the indexer's cursor advances and it sees 90–230 storefront events a tick) · UFC 0.0 % (frozen).

## Shipped

1. **Migration `20261009195532`, the zero-yield lanes plus the Pinnacle FMV cadence.** Six lanes were re-derived as finished: two are at the spork floor, four have drained queues, and each carries a positive control in its suppression reason. `rpc-pinnacle-mints-backfill` (jobid 84) is **deactivated**; it made 720 edge calls a day for 0 rows. `rpc-pinnacle-pull-chain-lane` now sleeps and runs only when there is work. `rpc-pinnacle-fmv-recalc-backstop` (jobid 200) moves `37 22 * * *` → **`37 1-22/3 * * *`**. Why: today's Star Wars drop (dist 8891, 414 opens 9:00–9:40 AM PT) had 5 new renders with 5–13 sales each by midday, but they read NO_DATA until the next 12-hourly recalc, so every pull of the drop was unpriced. It stays the FULL recalc on purpose: two instruments read `max(fmv_computed_at)`, and a second, narrower writer would mask a dead recompute. Revert: the header of the migration.
2. **`01776cd21` panini-ingest walk-order.** `panini_editions` passed the 20 × 1,000-row read cap on 10-06 (22,110 rows today). Every run since served `truncated` / `complete:false`, so the runner stopped promoting new grid discoveries and bootstrap was disabled. Both reads now page up to 100 pages. The test cases were re-pinned, a 22,110-row case was added, and a planted cap of 20 reds them. CI green; deploy READY.
3. **All Day storefront reconcile pages large storefronts (commit titled "storefront reconcile: page large storefronts…").** Since 2:13 AM PT every `allday-storefront-reconcile` run was `ok=false`: seller `0x779ffd206566b382` failed every walk. Reproduced through `pg_net`, the error is Cadence **"computation limit exceeded (used: 100001, limit: 100000)"**; their storefront holds 4,080 listing ids. The script now reads one 300-id slice per call, and its first row returns the total and the block height. Later slices are read at that height, so slices cannot shift. A failed slice fails the whole seller, so a partial storefront never closes listings as "vanished". Both slice shapes were verified on mainnet before shipping (page 1: 120 listings; last page at the pinned height: 56). 6 new tests; 2 planted defects caught (no height pin; a swallowed later page).
4. **Migration `20261009202625`: the smoke check's FMV freshness.** `analytics_smoke_run()`'s `freshness_fmv_per_collection` read WARN on every run today. The cause was `ufc_strike`, a frozen market (last sale 2026-05-13) that is re-snapshotted only weekly. A collection is now stale only when its FMV is past threshold AND a sale landed after it; past threshold but quiet is listed as `quiet_markets`. Applied as an md5-gated live rewrite (`6a6f777a…` → `e83d23aa…`).
5. **`/api/sets-db` paging ceiling (commit titled "sets-db: refuse a partial owned list at the paging ceiling").** Its local pager returned a partial list at 60,000 rows, but the largest wallets hold 69,520 All Day and 61,512 Top Shot moments. It now reads up to 200,000 and throws at the ceiling. The UI sends only Golazos there, but the public endpoint takes all three. Every other `fetchAllPaged` caller was checked against its live population: all under cap.
6. **Migration `20261009204812`: Pinnacle pack opens re-try pricing after 1 h (was 6 h).** Today's drop was tried before its renders had an FMV and could not be re-tried until ~3:46 PM PT. One interval changed; the pin gained a two-sided case; full local DB suite 251/251. Ran once: 414 / 414 opens of dist 8891 priced.
7. **Migration `20261009212009`: the accuracy-gate backtests read the buy-back registry.** `fmv_sales_backtest` / `topshot_fmv_backtest` hardcoded one Top Shot buy-back wallet, while `buyback_wallets` holds three, including the All Day issuer (#161). Both now read `sales_market`, and the guard's two suppressions are gone (a planted raw read reds it). It was latent: 0 registered buy-backs in the 7-day window, and the readings are identical after the change.
8. **#169 exit re-measured (docs).** The 10-05 routine ran without connectors and measured nothing. Today 13 of the 66 frozen editions have been re-priced; 34 still hold a 10-03 MEDIUM with 0 collector sales in 30 d. That is the 7-day re-snapshot rule (`fmv_recalc_historical_candidates`, `p_stale_after = 7 days`): they become eligible from ~2:48 PM PT 10-10. The invariant holds (30 d `sales` − `sales_market` = 710 = buy-backs). Close-condition and falsifier are in known-issues #169.
9. **Inbox:** the 10-06 chain-arrival filing has a ✅ RESOLVED section and its INDEX marker.

## Needs Trevor (decisions, not code)

- ✅ **ADDRESSED the same afternoon by the concurrent session (`87c2e2fc6`, migration `20261009205054`, ~1:50 PM PT):** a Pinnacle render under 7 days old now prices at the median of its last 5 sales and reads at most LOW (< 3 days) / MEDIUM (3–6 days). It takes effect at the next full recalc (3:37 PM PT, on the 3-hourly schedule from `20261009195532`). The sizing below was measured before that recalc. ~~**Drop-day FMV on a falling render.** Wick (LEV1-SWHA-WICK-S6) sold 45 → 37 → 23 → 50 (#7) → 20 in its first morning and reads **$37 HIGH** against a **$21 floor**. A deals surface will rank the floor as 43 % off. This is the falling-render lag #155 describes, made acute on day one; the 30-day-max cap does not bind on a fresh render. Options: a minimum age or minimum sale count before HIGH on a new render, or capping FMV at the live floor when the floor has depth. **Scope, measured 2:25 PM PT:** of 300 HIGH renders with a live floor, **4** have their floor more than 30 % under FMV, and none more than 50 %. Three of the four are recent LEV1 drop renders (`LEV1-SCGE-CHAL-S6` $9 vs $6, `LEV1-SCGE-RICH-S6` $70 vs $48, `LEV1-SWHA-WICK-S6` $37 vs $21). MEDIUM: 6 of 548. So it is a drop-week effect, not estate-wide drift. This is a pricing-model call, so nothing was changed here.~~
- **Checked and NOT a finding:** `aggregate_saved_wallet_stats` shows 2,789 PostgREST calls at a 5.0 s mean and a 30 s max in `pg_stat_statements`, but those stats were last reset **08-11**, so they pool across the 09-02 `top_tier` fold and the Large upgrade. Today the aggregate takes 196 ms and ~21 k buffers on a 19.7 k-moment saved wallet. The two `focus.md` sentinel steers (pack-EV `fmv_current` join; `top_tier` fold) are both settled: jobid 71 is 168/168 ok with a 3.7 s max, and the fold shipped.
- **`public_board_slow_count = 1`** is `panini_sale_feed_status`: an index-only scan over 2.4 M rows (~25 k blocks, read cold on each of its few calls), 1.8–3.1 s on the probe. It is already covered by `idx_panini_serials_feed_status`, and the board is rarely visited. The breach flips at its threshold on cache state, not on a regression. Materialising it is the only lever; not done.

## Post-ship watch (a check-in is scheduled into this session for 10-10 4:15 PM PT)

- `pinnacle-fmv-recalc` ~8 runs/day, durations ≤ ~30 s; `pinnacle_fmv_stale_hours` stays green.
- `pinnacle-pull-chain` ~144 runs/day; jobid 84 stays inactive; `check_zero_yield_lanes()` offenders [].
- ✅ No-change control already in: the first Golazos run on the paged script (1:43 PM PT) matched the run before it exactly (5,875 listings, 230 sellers, 0 closed / 0 vanished, ~12.7 s).
- ✅ First 3-hourly Pinnacle recalc ran at 3:37 PM PT: ok, 9.7 s, 2,358 renders priced. The concurrent session's young-render rule is now live: all 5 Star Wars renders read **LOW** (were HIGH). Wick is still $37 against a $20 floor, because the median of its last 5 sales (45/37/23/50/20) is $37. The LOW label is now the honest signal there.
- ✅ Positive control in: the 2:13 PM PT `allday-storefront-reconcile` run reads `ok=true`, 1,228 / 1,228 sellers, 0 walk errors, `onchain_listings` 15,664 (was 13,778), 423 inserted, 4 closed, 101.8 s.
- ✅ `analytics_smoke_run` at 1:43 PM PT: `freshness_fmv_per_collection` ok (only the live `pipeline_health_24h` warn remains).
- ✅ `rpc-pinnacle-pull-chain-lane` runs the lane only on 10-minute ticks (5 runs 1:00–1:40 PM PT, all ok; 50 cron dispatches averaging 1.6 s instead of ~15 s).
- panini-ingest: not yet verified. The laptop runner made no walk-order call at 2 PM PT (its previous run was still walking at 1:45 PM PT). The next run should log no `hit maxPages=20`, and the runner should log `complete=true`.
- #169: none of the 34 still MEDIUM on a pre-10-04 snapshot after ~4 PM PT 10-10. If so, close it.
