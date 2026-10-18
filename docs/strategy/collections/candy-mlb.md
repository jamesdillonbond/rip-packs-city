# Candy MLB — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

Candy MLB is RPC's only Solana collection: 125 editions, `is_active=true` since 09-06 (#63), with Overview, Market, Collection and Analytics tabs. It has no Packs tab and no Sniper, both by decision. All data comes from Magic Eden. The OpenSea lanes are parked (#58).

**The 10-11 jump in HIGH/MED share is a confidence-label change, not better prices. The labels are backed by an out-of-sample test, but the freeze means nothing has checked them since.** Read 2026-10-17 ~5:50 PM PT:

- **The denominator did not shrink.** `rpc_thp_leg_fmv_coverage` takes the latest `fmv_snapshots` row for every edition, with no filter. Both before and after the step it moves in 0.8-point steps (1/125): 27.2 = 34/125, 54.4 = 68/125, and today's 56.8 = 71/125 (HIGH 4 · MEDIUM 67 · LOW 54, all 125 recomputed in the last 24 h). The editions table also holds 125.
- **Cause: the ask-corroboration change.** Deploy `a56214193` (ledger 10-11, ~11:50 AM PT) let `candy_listing_floor.confirmed_floor_usd` corroborate a sales median within ±25 %, which lifts LOW to MEDIUM. Before that it only capped the price. First run: 1:08 PM PT. Of the 123 editions re-graded between 10-11 10 AM and 7 PM PT, 31 went LOW → MEDIUM, 1 went LOW → HIGH and 1 went MEDIUM → LOW. No migration touched the leg. No price moved, because the ceiling is a separate map.
- **The labels are justified:** before shipping, the lifted cohort was scored out of sample at **MdAPE 19.2 %, 67.5 % within ±25 %**, which is better than the existing MEDIUM (20.0 %) and far better than LOW-that-stays-LOW (27.3 %). The step also brings Candy back to the ~60 % it read before the 09-20 dispersion-gate demotion ([roadmap-status.md](../../reference/roadmap-status.md)). The 10-10 decision not to loosen the 0.35 gate still stands. This change adds corroboration; it does not relax the gate.
- **Nothing has re-checked the labels since:** only **2 Candy sales** (2 editions) have arrived since the relabel. The labels now compare pre-freeze sales medians against a standing ask book. That book counts as "fresh" because the listings sweep re-sees it every 3 h, not because anyone posts new asks.

**Sales ingestion runs, but the market is frozen.** The newest Candy sale in `sales` is **2026-10-11 8:21 PM PT**: 15 sales in 7 d, against 1,310 in 30 d. `candy-sales-indexer` ran 8/8 ok in the last 24 h with 0 rows. The listings (8/8, newest 5:35 PM PT 10-17) and offers (4/4) lanes are healthy. The live Magic Eden A/B on 10-14 matched our newest sale to the same second. Newest activity of any type: a delist at 10-12 7:24 AM PT. So the parser is correct, and the 10-13 "capture gone dark" filing was disproven. `candy_sales_stale_hours` was made indexer-health-aware on 10-14 (`20261014235448`). One open question remains: a Magic Eden freeze looks exactly like volume moving to OpenSea, which RPC does not index (#58, 10-15 note).

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
- **The freeze leaves accuracy unmeasured:** 2 sales since 10-11 means both the relabel and the price model are unscored. The 14 d backtest last read 26.8 % vs a naive 31.1 % ([roadmap-status.md](../../reference/roadmap-status.md)).
- **The share stays high only while pre-freeze sales are in the 30-day window.** If the freeze continues, the volume floor starts failing editions around **11-10 PT** and the share should fall. That fall would be honest, not a defect.
- **The ask counts as fresh because it is re-seen.** The 7-day ask-age bound checks `last_seen_at`, which a static book keeps renewing.
- **#66 (estate-wide):** external links stay held by the accuracy gate.

## Next — prioritized

**Now**
1. **Find out where Candy volume went (#58).** If Candy trades on OpenSea, RPC's FMV is pricing a dead venue. *Gate:* Trevor's key. *Falsifier:* the first OpenSea sales run (`windows_completed`) returns 0 sales since 10-12, which confirms a true market-wide freeze.
2. **Score the 10-11 relabel when sales resume.** Re-run the out-of-sample MdAPE on lifted vs native MEDIUM vs LOW. *Falsifier:* the lifted cohort scores worse than LOW-that-stays-LOW (27 %). If so, revert `a56214193`; the next recalc restores the labels.

**Next**
3. **Make corroboration ask a recency question about the sales too.** Require a sale within N days, or a newly posted ask, before an ask can lift an edition, so a frozen book cannot hold MEDIUM labels. *Gate:* measure first how many of today's 67 MEDIUM depend on corroboration. *Falsifier:* that count is ≈ 0.
4. **Pin the 11-10 drain expectation in the trust digest** so a falling share is read as a frozen market, not a regression.

**Later**
5. Re-derive the active-listing count on `count(distinct token_mint)` (#131 sizing note).
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
- **The tagline change** (#63) is his call ([chain-strategy.md](../../reference/chain-strategy.md), end).

## Where the detail lives

- Register: [known-issues.md](../../reference/known-issues.md) #58, #63, #131. Accuracy history: [roadmap-status.md](../../reference/roadmap-status.md).
- Solana address rules: [chain-strategy.md](../../reference/chain-strategy.md). Honesty canon: [key-files-and-honesty.md](../../reference/key-files-and-honesty.md).
- Ledger: [ledger.md](../../overnight/ledger.md), entries 10-11 (~11:50 AM / 1:40 PM PT), 10-13 and 10-14.
- Origins: [multi-chain-thesis-2026-05-30.md](../multi-chain-thesis-2026-05-30.md), [candy-go-live-flip-2026-07-25.md](../../candy-go-live-flip-2026-07-25.md), [parity-assessment-panini-candy-2026-07-19.md](../parity-assessment-panini-candy-2026-07-19.md).
- Latest pass: [handoff-2026-10-17-overnight-pass.md](../../handoff-2026-10-17-overnight-pass.md).
