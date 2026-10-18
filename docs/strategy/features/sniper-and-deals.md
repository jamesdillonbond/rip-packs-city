# Sniper & deals — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

The Sniper and Market rank live listings against FMV, and every row leads OUT to the marketplace with **"View Listing"**. RPC never buys, carts, offers or trades: the Cart and Trade Hub were deleted from the tree on 08-01 (#1, #3), and the outbound reframe shipped 05-23 (`b19d8f2`).

Surfaces:
- the per-collection `/<collection>/sniper` and Market tabs
- `/insights/pack-sniper` and `/insights/deals`
- deal alerts (see [concierge-and-alerts.md](concierge-and-alerts.md))
- the edition, binder and checklist "Floor" chips (`/api/best-asks` → `lib/asks/edition-live-ask.ts`, SQL twin `edition_live_ask()`)

**Listing sources, by collection** (24 h to 10-17 ~6 PM PT):

| collection | primary source | lane state |
|---|---|---|
| Top Shot | Atlas market feed (`atlas_market_drain`, `atlas_listing_verify_tick`, `topshot-active-listings-ingest`), plus the Flowty API | Atlas 403 rate is a 5–15 % Cloudflare baseline (#149). Active-listings ingest 7/7 ok |
| All Day | Flowty API (`allday-listing-cache`) | 72/72 ok, ~7.7k rows/day |
| Golazos | Dapper NFTStorefrontV2 (`golazos-storefront-reconcile`, every 2 h), plus Flowty | 12/12 ok; Flowty lane 72/72 |
| Pinnacle | live-listing sniper (09-27); its Flowty leg is dormant | — |
| Panini | Panini marketplace walk, all products since 10-10 | — |
| Candy MLB | Magic Eden; OpenSea indexers UNSCHEDULED until a key exists (#58) | ME silent since 10-12 |
| UFC | market closed (`lib/market-closed.ts`); the banner covers the sniper | — |

**The Flowty API is still alive on 10-17**, three weeks after Trevor's 09-25 "will turn off soon": 308 `cached_listings` rows are `source='flowty'`.

## Shipped recently (since mid-September)

- **09-23 Q0:** `fmv_from_cached_listings` caps FMV at the cheapest live ask and skips All Day. Closed by Trevor (09-25).
- **09-25:**
  - Golazos storefront reconcile found 1,391 live listings, against Flowty's 67 moments. Golazos ASK_ONLY is now priced from it (pg_cron 614).
  - Flowty readers price only listings ≤ 2 h old.
- **09-27 #155:** a falling Pinnacle render no longer reads as the top "deal".
- **10-09:** listing caches stop deleting live listings after a partial upsert failure.
- **10-10:**
  - #182 / #143 / #183 / #184: "Floor" on binder, checklist and tiles is the edition's OWN confirmed live ask (`low_ask_confirmed_at`), FMV-gated and ≤ 3×.
  - The Binder no longer dresses a week-old sale as "Ask".
  - The Panini Sniper went all-product.
- **10-13/14:**
  - Market badges read the edition's real badges (`editions.badges` is always empty: R104).
  - Team, Tier, Badge, Set, Series and Owned filters cover the whole market, not the 50 rows on screen.
  - A franchise filter covers every historic label.
  - UFC and Panini overview copy stopped promising deals they could not show.
- **10-14 E5/R123:** the four listing-cache routes write a heartbeat first and read their terminal log error.
- **10-15:**
  - A Flowty sweep that fetched ZERO is a FAILED run ("empty book", `f0b7f7ba5`), so a shutdown answering `200 []` alarms on its first tick.
  - R127: All Day opens on Recently Listed and MIN DISC. is shown again.
  - The stats bar no longer shows "0 deals · avg 0.0 %" before the first read.
  - A failed badge read is reported as a failed source.
- **10-16:** the Top Shot listing sync reads from a covering index: 7.5 s → 1.4 s.
- **10-17:**
  - The Pack Sniper shows real names, tiers and images: 0 of 50 rows read "Pack #<id>", down from 30.
  - The Atlas drain samples its open-listing count twice an hour, saving ~57 k of ~68 k blocks on 28 of every 30 ticks.

## Open issues

- **The Flowty shutdown is pending, on Flowty's clock.** The plan is written (roadmap-status, item 1, 09-25 + 10-15):
  1. Confirm the outage from the routes' own `pageErrors`, not from one probe.
  2. Retire the Flowty sweeps in three listing-cache routes, their schedulers, and `flowty-proxy`.
  3. Drop the `flowty` rows deliberately rather than waiting out the 48 h purge.
  4. Check that every `cached_listings` reader renders an honest "no listing source" state.
  - **No collection loses its listing source.** All Day and Golazos asks come from Dapper's own storefronts (`allday-storefront-reconcile` 12/12 ok and `allday-listings-indexer` 104/104 ok in 24 h, read 10-17 ~6:15 PM PT), and Top Shot's come from Atlas. Flowty-fed `cached_listings` rows feed no priced column (re-verified 10-03).
- **Candy:** no live listing or sales feed since 10-12. The pages say "None indexed" on purpose (focus.md 10-15).
- **`idx_tame_open_listing_by_seen` (183 MB, superseded):** ✅ dropped 10-17 evening (`20261018005800`, verified in prod; ledger).
- **D21:** All Day `edition_offers` bids run stale (median ~6 d).

## Next — prioritized

**Now**
1. ✅ **PRE-STAGED 2026-10-18 ~9:25 AM PT as a runbook:** [docs/operations/flowty-retirement-runbook.md](../../operations/flowty-retirement-runbook.md) — the dark-vs-flaky query (ALIVE ×3 at 9:15 AM PT: 72/72 ok per lane in 24 h), every scheduler, reader, test and row with counts, and the ordered teardown with reverts. Step 0 (repoint `get_platform_stats`, `get_cross_collection_deals` and the All Day/Golazos v1 route readers at `cached_listings_v2`) can ship before the day; the rest waits for three DARK ticks on all three lanes.
   - (original item) **Pre-stage the Flowty retirement as a ready diff:** the three `*-listing-cache` routes and their schedulers, `flowty-proxy`, the v1 display readers, and a deliberate drop of the `flowty` rows. Do not ship it until the outage is confirmed. Why: retiring on the day beats letting three lanes alarm for 48 h. Falsifier: the empty-book failure fires, or `pageErrors` is non-zero across 3 ticks.
2. ~~Find a second All Day listing source~~ — **already exists:** `allday-storefront-reconcile` (shipped 09-25, the same NFTStorefrontV2 walk as Golazos) ran 12/12 ok in 24 h to 10-17 ~6:15 PM PT. Nothing to build.

**Next**
3. **Series 2026-27 (10-20) Market and Sniper coverage.** New sets need badges, tiers and filters on day one. The 10-15 `atlas_editions_dispatch` re-probes the new-set frontier every ~10 min. Gate: the 10-20 ~7 PM PT verification task.

**Later**
4. **Candy listings**, if Trevor sets `OPENSEA_API_KEY` (#58). Re-schedule the three lanes and add watchlist rows in the same turn.

## Decisions on record (do not re-litigate)

- **Outbound "View Listing" only.** No cart, no buy, no make-offer, no gifting. #1 Cart was deleted 08-01, as was #3 Trade Hub.
- **Trading is NOT on this roadmap.** The 10-03 trading memo said "worth revisiting, do not build". The admin-only swap test is the second read-only exception, and turning trading into a user feature is Trevor's call alone. Do not propose it here.
- **Do not delete the Flowty ingest early.** It is live production ingest until the API actually goes dark (07-07 re-scope, still true 10-17).
- **The Deal-alert "zero_yield" lanes and the Lillard Archive filter stay** (declined 09-25).
- **Deal alerts fire once per LISTING**, not once per day (10-14; verified 10-16).

## Where the detail lives

- Flowty plan and listing-source history: [roadmap-status.md](../../reference/roadmap-status.md) ("Prioritized next actions", item 1).
- Market and sniper surfaces: [routes-and-surfaces.md](../../reference/routes-and-surfaces.md). APIs and Cadence: [apis-and-cadence.md](../../reference/apis-and-cadence.md).
- Trading memo: [trading-revisit-2026-10-03.md](../trading-revisit-2026-10-03.md). Read-only exceptions: [concierge.md](../../reference/concierge.md).
- Register: #1, #3, #58, #143, #149, #155, #182–#184 in [known-issues.md](../../reference/known-issues.md); R104, R127, D21 in [deep-audit-register.md](../../audits/deep-audit-register.md).
