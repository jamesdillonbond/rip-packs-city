# NFL All Day offer-source investigation (2026-06-01) — H4

**Question (handoff H4):** Can we build an `/api/cron/allday-offers-sweep` like the Top Shot
`offers-sweep`, walking All Day's marketplace GQL for an edition-level top-offer to populate
`edition_offers` and light up "Best offer" on All Day moment/edition pages?

**Answer: No — NFL All Day's marketplace GraphQL exposes no offer/bid data of any kind.**
There is nothing for a sweep to consume. Per the handoff's own fallback, H1 (hide the empty
"Best offer" cell) is the permanent answer for All Day, and it shipped this pass.

## How the Top Shot sweep works (for contrast)

Top Shot's `public-api.nbatopshot.com searchMarketplaceEditions` returns `highestOffer` **inline,
per edition**, in a paginated walk. `app/api/cron/offers-sweep/route.ts` cursors that feed and
upserts `(collection_id, external_id, highest_offer, low_ask)` into `edition_offers`. The reader
RPC `get_edition_high_offer` is collection-agnostic and surfaces those rows automatically.

## What All Day actually exposes

Probed live through `topshot-proxy /allday-consumer` (the same endpoint
`allday-fmv-populate` uses; consumer GQL hosts `searchMarketplaceEditions` for All Day).
Baseline query returns 200 with real data, so reachability/auth are fine.

`MarketplaceEdition` node fields confirmed present: `editionFlowID`, `lowestPrice`,
`averageSale`, `totalListings` (plus the schema-suggested `highestSale` / `highestPrice`).
**All listing/sale data — zero offer data.**

Field probes that all returned `Cannot query field … on type "MarketplaceEdition"`:
`highestOffer`, `topOffer`, `bestOffer`, `highestBid`, `topBid`, `offerCount`,
`activeOffersCount`, `highestActiveOffer`, `highestOfferPrice`, `topOfferPrice`,
`bestOfferPrice`, `highestOfferAmount`, and a node-level `offers { … }` connection.

Root-level offer queries probed — none exist on `Query`:
`searchOffers`, `getOffers`, `activeOffers`, `searchMarketplaceOffers`, `getEditionOffers`,
`editionOffers`, `searchMarketplaceEditionOffers`, `getEditionActiveOffers`, `getActiveOffers`,
`getOffersForEdition`, `searchEditionOffers`, `getMomentOffers`, `searchMomentOffers`,
`getOffersForMoment`, `getDapperOffers`, `marketplaceOffers`, `getMarketplaceOffers`,
`searchActiveOffers`, `getTopOffers`. (The schema does carry a `SearchOffers` *type* per a
did-you-mean hint, but no Query field consumes it — it's unreachable in the public consumer
schema, consistent with All Day's marketplace UI not surfacing aggregated edition offers.)

The All Day public-api route (`/allday`) 404'd through the worker; regardless, it shares the
NFL All Day GQL schema family that the consumer probe already exhausted.

## Why this is structural, not a wiring gap

`edition_offers` is 100% Top Shot (8,860 rows). `badge_editions.highest_offer` is 0/1,572 for
All Day. There is no upstream that produces an All Day edition offer aggregate. The only
theoretical path is on-chain: index `DapperOffersV2` (`0xb8ea91944fd51c43`) offer events into a
new pipeline and aggregate to edition level — a full Cadence event-indexer build (new
worker + cursor), far beyond a GQL sweep, and not justified until All Day "best offer" is a
demanded product surface. Not built.

## Net result shipped this pass

- H1: the "Best offer" cell is **hidden** when there's no positive offer (edition + moment
  pages), so All Day stops rendering a permanent `—`. `get_edition_high_offer` stays
  collection-agnostic, so if an All Day offer source ever lands in `edition_offers`, the cell
  returns automatically with no code change.
- H3: All Day editions now show the V1-Dapper `cross_market_ask` in the ask cell (2,705
  editions) when `badge_editions.low_ask` is null, recovering an ask signal where there was an
  em-dash.
