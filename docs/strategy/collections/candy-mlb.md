# Candy MLB — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

Candy MLB is RPC's only Solana collection: 125 editions, `is_active=true` since 09-06 (#63), with Overview, Market, Collection and Analytics tabs. It has no Packs tab and no Sniper, both by decision. All data comes from Magic Eden. The OpenSea lanes are parked (#58).

**The 10-11 jump in HIGH/MED share is a confidence-label change, not better prices. The labels are backed by an out-of-sample test, but the freeze means nothing has checked them since.** Read 2026-10-17 ~5:50 PM PT:

- **The denominator did not shrink.** `rpc_thp_leg_fmv_coverage` takes the latest `fmv_snapshots` row for every edition, with no filter. Both before and after the step it moves in 0.8-point steps (1/125): 27.2 = 34/125, 54.4 = 68/125, and today's 56.8 = 71/125 (HIGH 4 · MEDIUM 67 · LOW 54, all 125 recomputed in the last 24 h). The editions table also holds 125.
- **Cause: the ask-corroboration change.** Deploy `a56214193` (ledger 10-11, ~11:50 AM PT) let `candy_listing_floor.confirmed_floor_usd` corroborate a sales median within ±25 %, which lifts LOW to MEDIUM. Before that it only capped the price. First run: 1:08 PM PT. Of the 123 editions re-graded between 10-11 10 AM and 7 PM PT, 31 went LOW → MEDIUM, 1 went LOW → HIGH and 1 went MEDIUM → LOW. No migration touched the leg. No price moved, because the ceiling is a separate map.
- **The labels are justified:** before shipping, the lifted cohort was scored out of sample at **MdAPE 19.2 %, 67.5 % within ±25 %**, which is better than the existing MEDIUM (20.0 %) and far better than LOW-that-stays-LOW (27.3 %). The step also brings Candy back to the ~60 % it read before the 09-20 dispersion-gate demotion ([roadmap-status.md](../../reference/roadmap-status.md)). The 10-10 decision not to loosen the 0.35 gate still stands. This change adds corroboration; it does not relax the gate.
- **Nothing has re-checked the labels since:** only **2 Candy sales** (2 editions) have arrived since the relabel. The labels now compare pre-freeze sales medians against a standing ask book. That book counts as "fresh" because the listings sweep re-sees it every 3 h, not because anyone posts new asks.

**Sales ingestion runs, but the market is frozen.** The newest Candy sale in `sales` is **2026-10-11 8:21 PM PT**: 15 sales in 7 d, against 1,310 in 30 d. `candy-sales-indexer` ran 8/8 ok in the last 24 h with 0 rows. The listings (8/8, newest 5:35 PM PT 10-17) and offers (4/4) lanes are healthy. The live Magic Eden A/B on 10-14 matched our newest sale to the same second. Newest activity of any type: a delist at 10-12 7:24 AM PT. So the parser is correct, and the 10-13 "capture gone dark" filing was disproven. `candy_sales_stale_hours` was made indexer-health-aware on 10-14 (`20261014235448`). One open question remains: a Magic Eden freeze looks exactly like volume moving to OpenSea, which RPC does not index (#58, 10-15 note). ⓘ **10-19 ~8:25 AM PT, measured:** `candy-sales-indexer` now logs what it walks (`extra.activity_types`, `8b8306f2f`). Its first read: 500 activities 10-09 → 10-19 — `list` 171 · `bid` 116 · `buyNow` 98 · `delist` 86 · `poolUpdate` 28 — and the 98 `buyNow` are exactly the 98 ME sales already recorded before the 10-11 8:21 PM PT cursor. **Magic Eden has had 0 fills since, while bids and listings continue**; our sale-type filter is not the cause.

## Shipped recently (since mid-September)

- **09-19 → 09-25:** Collection tab and entity pages. Base58-safe addresses: ban at zero, plus `lib/address.ts` ([chain-strategy.md](../../reference/chain-strategy.md)). Name → wallet lookup. Magic Eden escrow handling. Board fan-out fix and duplicate-listing ingest fix (#131). Confirmed-floor FMV ceiling (09-25).
- **10-09:** Candy whale links, usernames and Analytics wallet cards no longer hit Flow-only hex gates.
- **10-10:** OpenSea listings/sales/offers lanes plus venue scoping, so the two venues cannot corrupt each other (dormant, no key). FMV 1.8.1 thin-edition 30-day drop (#140 data point). No lock UI for Candy.
- **10-11:** Ask-corroboration (above). `candy-offers-indexer` survives a timed-out Magic Eden page. Sentinel "13.4 h" read as a quiet market.
- **10-13:** OpenSea crons unscheduled until a key exists (guard `candy-opensea-schedules-are-parked-until-a-key-exists`).
- **10-14:** A window with no indexed sales no longer renders as "$0" (Market Pulse, overview tile, concierge `no_sales_indexed`). Stale-sales arm retuned. Every-collection wallet-cache metadata self-heal (D8).
- **10-17:** Candy pack art: `getImageUrl` no longer appends Top Shot's suffix to bare Arweave ids (`3bcf40138`, verified on the rendered page). OpenSea three-step "way back" documented everywhere.

## Open issues

- **#58: no OpenSea data.** RPC records zero Candy volume from OpenSea, where Candy is a launch partner. Shelved 09-23, lanes parked 10-13.
- **The freeze leaves accuracy unmeasured:** 2 sales since 10-11 means both the relabel and the price model are unscored. The 14 d backtest read 10-19 ~8:25 PM PT (n 516, nearly all pre-freeze): published MdAPE **22.2 % vs a naive 26.1 %**, within ±25 % 54.8 vs 48.6 (MEDIUM tied at 63.3; [fmv-pricing.md](../features/fmv-pricing.md) item 4). It was 26.8 % vs 31.1 % earlier ([roadmap-status.md](../../reference/roadmap-status.md)). It scores the labels in force at each sale, so not the relabel.
- **The share stays high only while pre-freeze sales are in the 30-day window.** If the freeze continues, the volume floor starts failing editions around **11-10 PT** and the share should fall. That fall would be honest, not a defect.
- **The ask counts as fresh because it is re-seen.** The 7-day ask-age bound checks `last_seen_at`, which a static book keeps renewing.
- **#66 (estate-wide):** external links stay held by the accuracy gate.

## Next — prioritized

**Now**
1. **Find out where Candy volume went (#58).** If Candy trades on OpenSea, RPC's FMV is pricing a dead venue. *Gate:* Trevor's key. *Falsifier:* the first OpenSea sales run (`windows_completed`) returns 0 sales since 10-12, which confirms a true market-wide freeze.
2. **Score the 10-11 relabel when sales resume.** Re-run the out-of-sample MdAPE on lifted vs native MEDIUM vs LOW. *Falsifier:* the lifted cohort scores worse than LOW-that-stays-LOW (27 %). If so, revert `a56214193`; the next recalc restores the labels.

**Next**
3. ~~Make corroboration ask a recency question about the sales too.~~ ✅ **Already enforced (measured 10-19 ~12:55 PM PT): FMV 1.8.2 (10-17) requires a sale in the last 30 days for MEDIUM, so a frozen book cannot hold the label past 30 days after the last sale.** All 62 HIGH/MEDIUM Candy editions (4 / 58) have a sale inside 30 days; 0 do not (LOW 63, of which 9 have none). With no new sales they leave on their own: 6 MEDIUM the week of 10-19, 35 MEDIUM + 4 HIGH the week of 11-02, 17 MEDIUM the week of 11-09 (newest last sale 10-11). No code change needed.
4. ~~Pin the 11-10 drain expectation in the trust digest.~~ ✅ **Pinned 10-19 ~7:35 PM PT as a dated STEER in [focus.md](../../overnight/focus.md)** (what the night pass and daytime monitor read before calling anything a regression). Re-measured at that time: HIGH 6 · MEDIUM 56 · LOW 63 (`candy_fmv_high_med_share_pct` 49.6). By the week their newest sale turns 30 days old: **6 MEDIUM the week of 10-19 (first exit 10-21 5:27 AM PT), 5 HIGH + 33 MEDIUM the week of 11-02, 1 HIGH + 17 MEDIUM the week of 11-09 (last exit 11-10 7:47 AM PT)**. Each exit takes effect at the next recalc after that time. ↳ **Read 10-21 ~6:30 AM PT (Cowork cloud):** HIGH 8 · MEDIUM 62 · LOW 55 (125). The 6 MEDIUM due this week are still MEDIUM — correctly: their newest sale is 09-21 5:28 AM PT, so they turned 30 days old at 5:28 AM PT today, AFTER the last recalc (2:35–3:55 AM PT); Candy recalcs run ~3 AM and ~3 PM PT, so they exit at the ~3 PM PT run. Falsifier (a) not hit. ⚠ **Falsifier (b) needs a second mechanism, not a defect:** 29 labels moved 10-20 3:08 PM → 10-21 3:55 AM PT with no new sale (LOW→MEDIUM 14, MEDIUM→LOW 7, MEDIUM→HIGH 4, HIGH→MEDIUM 3, LOW→HIGH 1). Sampled editions show the 30-day sale count FALLING (11→10→9) as old sales leave the window — losing an outlier tightens the spread under the 0.35 dispersion gate, which can lift a label as well as drop it; ask corroboration explains only 3 of the 29. So the share does not fall monotonically between the dated exits; read the dated exits, not the share. The steer also covers `candy_sales_stale_hours`: since ~10-18 8:21 PM PT it breaches its 7-day backstop (191 h vs 168 h at 7:20 PM PT 10-19). That is the arm doing what it was retuned to do, with the indexer healthy.

**Later**
5. ~~Re-derive the active-listing count on `count(distinct token_mint)`.~~ ✅ **Re-derived 10-19 ~7:20 PM PT: 1,498 active rows = 1,498 distinct mints (0 duplicates; `candy_market_board` the same; all Magic Eden).** The "1,821" in the `app/api/market/route.ts` / `lib/collections.ts` comments is a dated 09-12 census taken before the 09-23 #131 dedupe, so it may carry up to the +8.7 % inflation #131 measured. Do not re-quote it; quote the live count.
5a. ✅ **FIXED 10-19 (code): the Deals tab's empty state said it "will populate when listings open" with 1,498 open asks.** `candy_deals_board` reads **0 rows**, and that is structural, not a broken feed. Since the 09-25 confirmed-ask ceiling, FMV never exceeds the cheapest ask seen in 12 h: 0 of 1,498 active asks are below FMV, and on 120 of 124 listed editions the FMV is at or under the confirmed floor. A row can appear only when a new ask undercuts FMV between the listings sweep and the next recalc. The copy now says that, and a test asserts the old claim is absent. ⓘ **Consequence:** the Candy chip on `/insights/deals` is empty for the same reason. That follows from Trevor's 08-07 rule ("a base FMV above buy-it-now fabricates deals"), so it is correct, not a defect to fix.
6. Candy on the public accuracy table stays at its true value. No growth push until the gate passes. No paid tier until 100 WAU. No spend: the OpenSea key is free and the instant 7-day key is banned.

## Decisions on record (do not re-litigate)

- **0.35 dispersion gate stays** (10-10). Fix the share with real accuracy or more sales, never by relabelling.
- **No Packs tab, no Sniper.** Zero `pack_distributions` rows; `/insights/deals` covers deals. `sellerFeeFor("candy_mlb")` is `null` on purpose (#63).
- **No lock UI** (10-10).
- **OpenSea lanes unscheduled, not failing** (10-13). Routes stay in the tree.
- **`app/api/candy-sales-indexer/route.ts` is correct; do not touch it** (10-14 A/B).
- **Read-only product** throughout.

## Needs Trevor

- **#58: three steps.** (1) Create a permanent OpenSea API key at opensea.io/settings/developer (not the instant key). (2) Set `OPENSEA_API_KEY` in Vercel for all environments and redeploy. (3) Restore the three cron lines and delete the parked guard (way back is in #58).
- ✅ **The tagline change (#63): DONE 10-17 under delegation.** The root title is chain-neutral ([chain-strategy.md](../../reference/chain-strategy.md)).
- **#58 revisit trigger:** if Candy still has 0 indexed sales on 11-10, the OpenSea key becomes the cheapest way to tell a freeze from a venue move.

## Where the detail lives

- Register: [known-issues.md](../../reference/known-issues.md) #58, #63, #131. Accuracy history: [roadmap-status.md](../../reference/roadmap-status.md).
- Solana address rules: [chain-strategy.md](../../reference/chain-strategy.md). Honesty canon: [key-files-and-honesty.md](../../reference/key-files-and-honesty.md).
- Ledger: [ledger.md](../../overnight/ledger.md), entries 10-11 (~11:50 AM / 1:40 PM PT), 10-13 and 10-14.
- Origins: [multi-chain-thesis-2026-05-30.md](../multi-chain-thesis-2026-05-30.md), [candy-go-live-flip-2026-07-25.md](../../candy-go-live-flip-2026-07-25.md), [parity-assessment-panini-candy-2026-07-19.md](../parity-assessment-panini-candy-2026-07-19.md).
- Latest pass: [handoff-2026-10-17-overnight-pass.md](../../handoff-2026-10-17-overnight-pass.md).
