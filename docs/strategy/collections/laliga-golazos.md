# LaLiga Golazos — collection roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; every number is a dated sample — re-derive before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Defects: [known-issues.md](../../reference/known-issues.md) (item text wins over this file).

## Where it stands

**The verdict: the pipelines are healthy and the market shows no activity. The honest product answer is a label, not more pricing.** Live reads were taken 2026-10-17, ~6:00 PM PT.

- **Sales.** The newest Golazos sale in `sales` is **2026-10-01, 10:26 PM PT**, and there has been **1 sale in 30 days**. The ~60 sales/30 d quoted in September came in bursts: 09-10 had 16 and 09-12 had 38, and every other day of the 50-day window had **0**. So "thin" really meant a few bursty days.
- **Listings.** `golazos-storefront-reconcile` still reads **`live` = 4,286 exactly** at 5:43 PM PT, with 0 inserted, closed, vanished or reopened across 229 walked sellers and 5,876 on-chain listings. That same count was first flagged on 10-14 after 37 runs ([ledger 10-14](../../overnight/ledger.md)), so the book has now been flat for **about 7 days**.
- **Accuracy gate.** The HIGH/MEDIUM share is **1.0 %** (`rpc_trust_health_precompute`, computed 12:48 PM PT). It has read 1.0–1.2 on every leg since 10-04, and 1.0 flat since 10-13. `fmv_current` holds 575 editions: **479 ASK_ONLY**, 76 NO_DATA, 9 LOW, **6 MEDIUM**, 5 STALE.
- **The 1.0 % rests on a deliberate 90-day path, not a stale-label defect** (re-derived ~7 PM PT 10-17). All **6 MEDIUM editions have `sales_count_30d = 0`** (last sale 34–78 days ago; algo 1.8.1; FMV $0.20–$1.00; all recomputed 10-17). That is `fmv-recalc` Step 2a-quater/quinquies working as designed: a thin edition's window widens to 90 d and may earn MEDIUM on ≥ 5 sales there. Only HIGH requires 30-day volume (`gateHighToRecentVolume`, Trevor 08-07: "HIGH stays ≥7 sales/30d"). See Open issues.
- ⚠ **`golazos_fmv_pct_stale_30d` = 0.0 is a pipeline-liveness metric, not price freshness.** It checks `computed_at`, not the age of the last sale ([roadmap-2026-08-03 §3.1](../roadmap-2026-08-03.md)). Never quote it as "prices are fresh".
- **Lanes, last 72 h.** Every Golazos lane in `pipeline_runs` is ok=true: sales-indexer 235/235, listings-indexer 308/308, storefront-reconcile 36/36, listing-ask-fmv 36/36, badge-low-ask 144/144, pack-EV 12/12. The sales and listings indexers wrote **0 rows**. Their `v2_dapper_typeids_seen` lists Top Shot, All Day, Pinnacle and pack types, but **no Golazos type**.
- **Schedules.** pg_cron 614 `refresh-golazos-ask-fmv` runs `55 */2 * * *` (every 2 h; the 6 h figure is the `verified_at` bound, not the cadence).- **Wallet cache.** `wallet_moments_cache` holds 9,183 Golazos rows, **0 shells**, all priced (min $0.11, median $0.90). The 08-03 figure of "4,249 shells draining" is closed.

## Shipped recently (since mid-September)

- **10-18 (Claude Code cloud, verified on production ~2:57 PM PT): the Market page and the Sniper's relative-deals board read the on-chain book.** `/laliga-golazos/market` had no arm in `/api/market` and showed Flowty's 100 v1 rows as the whole market; it now reads `get_golazos_market_editions` (496 editions, 4,286 asks) and never falls back to v1. `get_relative_deals` moved to `cached_listings_v2` too (its flowty.io links were dead). The concierge's Golazos deal and search tools moved the same day. Nothing Golazos users see now depends on Flowty.

- **09-24:** The pack +EV board ranks on a live ask, not on retail. This extended #50 to All Day and Golazos (`20260925030613`/`…030943`); before it, all 12 Golazos +EV rows were bogus.
- **09-25:** `golazos-storefront-reconcile` shipped (Vercel, every 2 h). It reads Dapper's NFTStorefrontV2 into `cached_listings_v2` and found 1,391 live listings across 442 editions, against 67 on Flowty. ASK_ONLY is priced from it by `refresh_golazos_ask_fmv_from_listings` (pg_cron 614). `fmv_from_cached_listings` prices no Golazos editions. ([roadmap-status](../../reference/roadmap-status.md), Flowty block.)
- **10-03:** The last Flowty-fed write into a priced column was removed (`update_badge_low_ask_from_cached_listings` via `golazos-listing-cache`). **Golazos has no data dependency on Flowty.**
- **10-10:** Golazos joins `COLLECTIONS_WITHOUT_LOCKING`, verified on-chain, because a never-checked lock had rendered as "Unlocked". Pack-open tables match Dapper's index (266 = 266).
- **10-11:** `get_relative_deals`, the Sniper's Golazos/UFC fallback, went from 1,325 → 49 ms with identical output (`20261011194733`). `app/api/cron/compute-laliga-pack-ev` was retired; edge function `compute-golazos-pack-ev` (jobid 44) is the live writer.
- **10-14:** A `golazos-listing-cache` invocation heartbeat (E5/R123). The 6 credential-literal edge functions, including `backfill-golazos-series`, `scan-golazos-wallet` and `seed-golazos-editions`, now answer 410 (R21).
- **10-15:** The `golazos_sales_v1_backfill` "finished backfill" suppression was made **permanent** (`20261015195905`, 1:11 PM PT). ⚠ The 10-15 and 10-16 handoffs still carry it as pending SQL; that is stale.
- **10-15:** A Flowty sweep that fetches zero now fails the run (`f0b7f7ba5`).

## Open issues

1. **Market frozen, or venue invisible?** This item is with Trevor. The sales and listings indexers read the **same NFTStorefrontV2 event stream**, so their agreement is **one instrument, not two** (the #78 lesson, 09-11). The storefront reconcile is a stronger, *state*-based read: a flat book with 0 closes means nothing on V2 was bought or delisted. But `v_collection_marketplace_status` names the **primary venue `golazos_native`** (laligagolazos.com) next to Dapper Market. If trading moved to a contract we do not read, every lane would look exactly like this.
2. ✅ ~~**Stale venue row.**~~ **DONE — re-verified on chain 2026-10-17 (PT)**: the row now reads `secondary_status` `idle_since_2026_10_02`, `last_verified_at` 2026-10-17 8:45 PM PT, notes citing the independent Withdraw-event count (re-read 10-18 ~5:25 PM PT). The All Day row had the same rot the other way (V1 named primary; V2 carries ~99 % of sales): fix parked in `docs/pending-sql/20261018-marketplace-status-allday-primary-venue.sql`. *Original text:* `v_collection_marketplace_status` for Golazos said `healthy` / `live` / `buy_ctas_enabled=true`, `last_verified_at` **2026-07-04**, with notes still citing "296 listings / 135 active". After 3 months unverified, it is the claim most likely to be false on-screen.
3. **MEDIUM with zero 30-day sales (6 editions): a product question, not a bug.** Re-derived 10-17: the 90-day MEDIUM path is the 08-07 design. Whether MEDIUM should also need a recent sale is Trevor's call, and it would apply to every collection. Measure it first: backtest 90-day-only MEDIUM rows against their next sale before proposing any change.
4. **Pack EV is unbuyable by construction.** Golazos has 202 rows, all original supply and none actionable ([roadmap-2026-08-03](../roadmap-2026-08-03.md)). On 10-17, 0 of 32 pack rows had a price; that is honest, not a sort defect.
5. **No offers exist.** Golazos has no DapperOffersV2 offers of either type (settled 07-28; known-issues `badge_editions.low_ask` bullet). Any "best offer" surface stays empty, correctly.
6. **The Flowty `golazos-listing-cache` still runs.** It made 216 runs in 72 h, fetching 1,000 per run, with `editions_mapped` 0. It feeds legacy `cached_listings` only and is a teardown candidate for the day Flowty goes dark (roadmap-status, Flowty 10-15 note).

## Next — prioritized

**Now**
- ✅ **SETTLED 10-17 ~8:30 PM PT: the market is idle, our venue is not blind.** Independent on-chain count (Flow REST, `A.87ca73a41bb50ad5.Golazos.Withdraw`, 10-02 00:00 PT → 10-17 ~8:10 PM PT, 6,842 × 250-block ranges, 0 failed): **1 event**, tx `240dcfd5…ca37` (10-05 7:13 PM PT) — a `PackNFT.Opened` pack reveal, gas only. **Zero secondary trades on any venue** (a Dapper Market or laligagolazos.com trade must emit a Golazos.Withdraw). Positive control, same script, 09-10 → 09-13: 54 Withdraws in 54 txs = the 16 + 38 `sales` rows of those days. The dormancy label (Next) is now unblocked.
- (original item) **Settle whether the market is dead or our venue is blind.** Why: the honest label depends on which one it is. Falsifier: one independent probe, such as a Golazos.NFT `Deposit`/`Withdraw` count over 10-02 → 10-17 from Flow REST, or a manual check of laligagolazos.com and dapper.market/laliga recent sales. If transfers or sales appear that `sales` lacks, this is an ingest gap and outranks everything below. If there are none, record it as dormant.
- ✅ **Row corrected 10-17 9:18 PM PT** (`20261018041800`): `secondary_status` `idle_since_2026_10_02`, notes from the on-chain measurement, `last_verified_at` stamped; status/buy CTAs unchanged.
- (original item) **Re-verify and correct the `v_collection_marketplace_status` row.** Why: it publishes a 07-04 "healthy/live" claim. Gate: the outcome of the probe above. Write `secondary_status` and `notes` from the measurement and stamp `last_verified_at`.
- ✅ **Backtested 10-17 ~9:30 PM PT (estate-wide; Golazos has too few sales to score alone):** 90-day-only MEDIUM trails 30-day MEDIUM — Top Shot 20.0 % vs 14.0 % median error (n 483), All Day 33.5 % vs 20.0 % (n 145). The decision and its M1 cost are in [fmv-pricing.md](../features/fmv-pricing.md) → Now.
- (original item) **Backtest the 90-day-only MEDIUM path** (explained 10-17: designed, not a stale label). Why: on a frozen book the label rests on sales up to 90 d old. Falsifier: 90-day-only MEDIUM rows score as well as 30-day MEDIUM against their next sale, which would leave the 08-07 rule standing. Any change is estate-wide and Trevor's call.

**Next**
- ⛔ DECLINED by Trevor 10-17 9:27 PM PT (see Decisions). **Show a dormancy label instead of a price.** If the market is confirmed dormant, show "No sales since 2026-10-01", or extend `MarketplaceStatusBanner` beyond UFC's `shutdown` copy, on overview, sniper and edition. ASK_ONLY stays labelled as an ask, never as a value. Why: the roadmap says that for an illiquid market the label is the product. Gate: the probe settles "dormant".
- ⛔ DECLINED by Trevor 10-17 9:27 PM PT (see Decisions). **Fit relative-deals copy to the market.** Overview copy says "deals you can act on". On a book with 0 closes in 7 days that over-promises; revise it alongside the label. Gate: the dormancy decision.

**Later**
- **Retire the Flowty Golazos sweep and `flowty-proxy` when Flowty turns off.** Confirm by the routes' `pageErrors` first, then drop the `flowty` rows deliberately.
- **Re-measure the gate only when sales resume.** Do not chase the share with thresholds: 0 of the editions that sold had more than 3 sales in a month (09-10 block). Falsifier: 30-day sales return above the September bursts.
- **No new Golazos features, growth or spend** until the accuracy gate and the 100-WAU rule allow them.

## Decisions on record (do not re-litigate)

- **No dormancy label (Trevor, 2026-10-17 9:27 PM PT):** "We don't need to show that Golazos is quiet. Users can make their own judgement." The market is idle (on-chain count 10-17: 0 trades 10-02 → 10-17), and the record says so (`v_collection_marketplace_status`, `20261018041800`), but no banner, chip or copy change on-screen.
- **Golazos' ~0–1 % share reflects the market, not the model.** Do not move thresholds for it (roadmap-status 09-10 and 09-18 blocks).
- **Golazos asks come from Dapper's NFTStorefrontV2 (pg_cron 614)**; Flowty is not a data source (09-25, re-verified 10-03).
- **No lock UI for Golazos** (10-10, verified on-chain).
- **The `golazos_sales_v1_backfill` cursor alarm is permanently suppressed** as a finished backfill (`20261015195905`).
- **The product is read-only:** no cart, trading or offers. Pack EV is labelled Retired/original-supply, never actionable.

## Needs Trevor

- **Is LaLiga Golazos still trading, and where?** Carried since 10-14. Is it on the native laligagolazos.com marketplace, Dapper Market, or paused (licence or season)? His answer decides between "dormant label" and "ingest gap".
- If it is dormant: approve the user-facing dormancy copy and whether Golazos keeps buy-out links.

## Where the detail lives

- Accuracy gate history and liquidity ceiling: [roadmap-status.md](../../reference/roadmap-status.md)
- Original thesis and the Golazos 0.7 % baseline: [roadmap-2026-08-03.md](../roadmap-2026-08-03.md)
- #50 (pack +EV), #78 (listings lane; the shared-upstream lesson): [known-issues.md](../../reference/known-issues.md)
- Frozen-book evidence: [handoff-2026-10-14-claude-code-health-audit.md](../../handoff-2026-10-14-claude-code-health-audit.md); ledger 10-14 6:15 PM PT entry in [ledger.md](../../overnight/ledger.md)
- Month log: [sessions/2026-10.md](../../sessions/2026-10.md)
- Collection vocabularies and UUID (`06248cc4-…`): [schema-truth.md](../../reference/schema-truth.md)
