# Feature parity across collections — one matrix (read 2026-11-09 ~10:15 PM PT)

> Dated snapshot; re-derive any number before quoting. This file is the **cross-collection rollup**. The per-collection matrices carry the evidence for each cell and win over this file where they disagree: [panini.md](collections/panini.md) (10-25/26, 11-04), [nfl-all-day.md](collections/nfl-all-day.md) (10-26..28), [disney-pinnacle.md](collections/disney-pinnacle.md) (10-26), [candy-mlb.md](collections/candy-mlb.md) (10-26, 11-08). Golazos and UFC had no matrix before tonight; their columns are read from the registry, the live routes and their roadmap files. Canonical plan: [roadmap-2026-10-17.md](roadmap-2026-10-17.md). Defects: [known-issues.md](../reference/known-issues.md).

**Why this file exists.** Trevor, 11-09: "make sure that you've updated the roadmaps for all of our features and supported collections … as we try to get as much feature parity support across all of our collections." Six files each compared one collection with Top Shot; nothing showed all seven side by side, so a gap that is open on three collections read as three unrelated lines.

**Legend.** ✓ live · ◐ partial (see note) · ✗ gap we could close · — not applicable (the collection has no such thing upstream, or Trevor decided against it; the note says which).

## 1. Tabs (from `lib/collections.ts` `pages`, read by script tonight)

| Tab | Top Shot | All Day | Pinnacle | Golazos | UFC | Panini | Candy |
|---|---|---|---|---|---|---|---|
| Overview · Collection · Sets · Analytics | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Market | ✓ | ✓ | ✓ | ✓ | — closed market | ✓ | ✓ |
| Packs | ✓ | ✓ | ✓ | ✓ | — no pack data | ✓ | ✓ |
| Sniper | ✓ | ✓ | ✓ | ✓ | — closed (Trevor, 09-06) | ✓ | — by decision (10-26) |
| Pack Sniper | ✓ | ✓ | — packs are not resold (0 listed, 10-26) | ✗ no priced pack rows (0 of 32, 10-17) | — | — 0 of 351 listed packs clear their floor (10-25) | — |
| Hot Floors | ✓ | ✓ | ✓ | ✗ | — | ✓ | — no sale since 10-11 |
| Play · Challenges | ✓ | — no All Day quests on Atlas (10-28) | — | — | — | — | — |
| Product index (series counterpart) | series pages | series pages | series pages | series pages | series pages | ✓ `/product` | — |
| Team pages (`teamPages`) | ✓ | ✓ | — characters | ✓ | — | ◐ via franchise hubs | ✓ |

## 2. Entity pages

| Surface | Top Shot | All Day | Pinnacle | Golazos | UFC | Panini | Candy |
|---|---|---|---|---|---|---|---|
| Edition: FMV, chart, sales history | ✓ | ✓ | ✓ | ✓ | ✓ archive | ✓ | ✓ |
| Edition: listings / % listed | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Edition: offers | ✓ | ✓ | — none exist upstream (10-26) | — none exist upstream (07-28) | — | ✓ | ✓ |
| Edition: Top Owners | ✓ | ✗ needs an ownership walk (Dune cap) | ✓ (≥ 95 % attributable pins) | ✗ not built | ✗ not built | ✓ counts only | ✓ exact (census) |
| Edition: found in packs | ✓ | ✓ | ✓ | ◐ | — | ✓ by product | — pack contents unknown |
| Edition: special serials | ✓ | ✓ | ✓ serial premium | ◐ | ◐ | ✓ | ✓ |
| Edition: ask history | ✓ | ◐ | ◐ | ◐ | — | ✓ | ✓ (from 10-26) |
| Edition: price alerts | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Player / character page + season stats | ✓ | ✓ | ✓ character | ✓ (ESPN box scores, 11-08) | ◐ no stats | ✓ | ✓ |
| Player checklists (10-31) | ✓ | ✓ | — | ✓ | ✓ | — | ✓ |
| Team checklists | ✓ | ✓ | — | ✓ | — | — | ✓ |
| Cross-collection player / franchise hubs | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |

## 3. Wallet, trading, concierge

| Surface | Top Shot | All Day | Pinnacle | Golazos | UFC | Panini | Candy |
|---|---|---|---|---|---|---|---|
| Collection tab input | Dapper address / username | same | same | same | same | Panini username | Solana address |
| Portfolio value by day | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| "Close to completing" sets | ✓ | ✓ | ✓ | ◐ | ◐ | ✓ | ✓ |
| Trophy cases / pins | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ MLB only (11-09) |
| Trade room (`/trades`) | ✓ | ✓ | ✗ not tradeable here | ✓ | ✓ | — no wallet concept | — Solana |
| Trade-in finder | ✓ | — Top Shot product | — | — | — | — | — |
| Concierge: FMV, deals, wallet, sets, packs | ✓ | ✓ | ✓ | ✓ | ✓ archive | ✓ | ✓ |
| Concierge refuses rather than substitutes Top Shot rows | n/a | ✓ (10-26) | ✓ (10-26) | not re-probed | not re-probed | ✓ | ✓ (10-26) |

## 4. Insights boards with a leg per collection

Top Shot has every board. Legs elsewhere: **All Day** — deals, top sales, trophies, market cap, market pulse, pack sniper, account value, special-serial owners, buyback, offer-spread, first-mint, rookies (NFL 2025), squeeze, set-squeeze, squeeze-check, TC report, market index, serial premiums. **Panini** — squeeze (with Bid vs Floor and Floor movers tabs), deals, premiums. **Pinnacle** — top sales, hot floors. **Candy** — its own `/insights/candy-mlb` (scarcity, serials, holders), trophies. **Golazos, UFC** — cross-collection boards only.

## 5. The numbers behind the cells (read tonight, 10:10 PM PT)

| Collection | Editions | With an FMV | HIGH/MED share | Sales, 7 d | Wallets cached |
|---|---|---|---|---|---|
| NBA Top Shot | 14,840 | 14,840 | 46.1 % | 19,864 | 415 |
| NFL All Day | 6,190 | 6,190 | 28.7 % | 3,987 | 325 |
| Panini | 42,898 | 42,898 | 44.7 % | own table | by username |
| Candy | 22,768 | 190 | 0.5 % | 0 (frozen since 10-12) | 14,092 |
| UFC Strike | 617 | 617 | 0.0 % | 0 (closed 05-13) | 152 |
| LaLiga Golazos | 575 | 575 | 0.2 % | 0 | 155 |
| Disney Pinnacle | own catalog | own catalog | own gate | own table (268 / 24 h on the Sentinel) | 191 |

Price accuracy against realised sales, 7 days (`fmv_sales_backtest`, published, ALL): **Top Shot** ratio 1.00, 14.2 % median error, 69.2 % within ±25 % (n 18,253). **All Day** ratio 0.92, 20.0 %, 59.0 % (n 3,811).

## 6. Gaps ranked — what parity work is actually left

A gap is listed only where the data exists or could exist; "—" cells above are not work.

1. **Candy: 22,578 of 22,768 editions have no price.** The 11-08 scope decision catalogued every Candy collection; the census created the editions, and FMV only follows sales. Candy sales stopped 10-12. This is the Sentinel's Edition Coverage warn (74.3 %). Options are a decision, not a build — see "Needs Trevor".
2. **All Day Top Owners / Top Collectors.** Needs an ownership walk; the free Dune plan's datapoint cap is ~88 % used by Top Shot. Blocked on spend (no spend before revenue).
3. **Golazos Hot Floors and Pack Sniper.** Both would be empty boards today (0 sales in 7 days; 0 priced pack rows). Build only if the market wakes — the 10-20/21 burst (87 sales) is the kind of event to re-check on.
4. **Golazos / UFC Top Owners.** `wallet_moments_cache` holds ~155 wallets each: a lower bound too thin to rank honestly. Same class as All Day's.
5. **Pinnacle in the trade room.** Trevor's 11-03 rule holds assets in the Dapper account; whether a Flow Wallet can move a Pinnacle pin held there is untested.
6. **Golazos and UFC concierge substitution check.** All Day, Pinnacle and Candy were probed on 10-26 for tools answering with Top Shot rows; Golazos and UFC were not re-probed after those fixes.
7. **Two h1 defects (fixed tonight).** Panini Collection / Analytics / Product shipped two `<h1>`; the Packs tab of Panini and Candy shipped none.

## Needs Trevor

- **Candy coverage (gap 1).** Three ways to make the Sentinel line honest: (a) leave it — the warn stays until Candy trades again; (b) count coverage only over collections with an open market, and report Candy beside it the way sales ingest already says "silent by decision"; (c) price legacy Candy editions from Magic Eden's per-collection floor, labelled as a collection floor. (c) is a pricing-method decision and the least defensible number.
- **Dune spend for All Day ownership (gap 2)** — only if All Day owner boards are worth a paid plan before revenue.
