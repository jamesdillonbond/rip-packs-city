# Handoff 2026-06-16 — Underpriced #1s deal board (Item 2): foundation shipped, ingest blocked on a feed

This is the status + precise remaining-work record for the serial-intelligence roadmap **Item 2** ("Underpriced #1s" deal board). A daytime Claude Code session shipped the durable DB interface and de-risked feasibility; the ingest + public page are deferred with a concrete plan because the data prerequisite genuinely does not exist yet.

## What shipped (live, verified)

Migration `topshot_active_listings_and_underpriced_serials_board`:

- **`public.topshot_active_listings`** — the stable contract for current per-serial TS asks. One row per listed serial: `edition_id, edition_key, serial_number, nft_id, ask_usd, serial_fmv_usd, listing_resource_id, listing_url, listed_at, last_seen_at, active`. PK `(edition_id, serial_number)`. RLS on, no policies (service_role/postgres bypass; no anon). **Empty until the ingest below lands.**
- **`public.topshot_underpriced_serials_board`** — the "thin view" the roadmap specified: active **#1 OR perfect** (`serial = circulation_count`) listings, JOINed to `serial_fmv_estimate(...)`, `WHERE ask < estimate`, ranked by `discount_pct` desc. `security_invoker=on`, granted `service_role` (the public API route will read via `supabaseAdmin`, exactly as `/api/public/insights/serial-premiums` does). Columns include `discount_usd`, `discount_pct`, `serial_multiplier`, `serial_bucket`, `edition_fmv_usd`, `confidence`.
- **Verified**: a seeded Devin Booker `#1` (`231:8305`, circ 45, LEGENDARY) listed at $150 surfaced at **40.5% / $102.19** discount vs its `serial_fmv_estimate` of $252.19 (confidence HIGH). Seed deleted; table back to 0 rows. The moat logic is proven correct against the real function.

Revert: `DROP VIEW public.topshot_underpriced_serials_board; DROP TABLE public.topshot_active_listings;`

## The blocker (why the ingest + page are NOT shipped)

The deal board needs **current per-serial TS asks**. That feed does not exist today:

- `ts_listings` (the old Flowty-fed table the sniper feed still reads) is **dead** — 1 row, last ingest **2026-05-15**, the `ts-listing-ingest.yml` GHA workflow no longer exists. Flowty's marketplace shut down 2026-05-13.
- `cached_listings_v2` is empty for TS; `badge_editions.low_ask` is edition-level (lowest ask across all serials), not per-serial.

So the prerequisite is a real per-serial ask feed, which is a data project, not a quick win. (The roadmap doc correctly called this "BLOCKED today.")

### Feasibility de-risking done this session (TS marketplace GQL)

`lib/chains/flow/topshot.ts` `topshotGraphql` hits `https://public-api.nbatopshot.com/graphql` **directly** (no proxy secret) and works from a server (the `topshot-sales-history-backfill` route uses it live). Probing that endpoint (introspection is **disabled**; HTTP 422 carries structured GraphQL errors):

- `searchMarketplaceListings(input: SearchMarketplaceListingsInput!)` **exists and is reachable**.
- Return type is `SearchMarketplaceListingsResponse`, whose `data` field is type `SearchMarketplaceListingsSummary` (fields confirmed via "Did you mean…": it has `searchSummary` and `filters`). This is a **summary/facet** shape, **not** the clean `data{searchSummary{pagination, data{...rows}}}` row-list envelope `searchMarketplaceTransactions` uses. The exact path to **individual per-serial listing rows (serial + ask + listingResourceID)** was not nailed down from the vague validation errors alone.
- **Recommended next step**: capture the exact `searchMarketplaceListings` (or per-moment listing) query + variables from the Top Shot web app's browser network tab — the reliable way to get the real schema (introspection is off, and guessing risks a silently-broken ingest, the failure class this repo keeps getting bitten by). The per-serial ask may instead live on the moment query (e.g. `getMintedMoment(...).lowestPriceListing`); confirm which.

## Remaining build (in order)

1. **Ingest** `/api/cron/topshot-active-listings-ingest` — mirror the `topshot-sales-history-backfill` safety pattern (synchronous, ~120–180s self-budget under the 300s hard cap, idempotent, logs `pipeline_runs`, `?dryRun`/probe mode). Candidate editions = those where `serial_fmv_estimate` returns a non-null #1/perfect estimate (HIGH/MEDIUM fmv + multiplier coverage). Per edition: fetch its current #1 and perfect-serial asks via the confirmed GQL query; upsert into `topshot_active_listings` (PK `(edition_id, serial_number)`); mark not-seen-this-sweep rows `active=false`. Optionally store the estimate in `serial_fmv_usd` at write time.
2. **Operator**: add a cron-job.org entry for the new route (Bearer `INGEST_SECRET_TOKEN`), low cadence (e.g. every 30–60 min). The board is inert until this runs once — same activation pattern as the omni-channel alerts ship.
3. **Public surface** — `/api/public/insights/underpriced-serials` (read `topshot_underpriced_serials_board` via `supabaseAdmin`, mirror the serial-premiums route) + `/insights/underpriced-serials` page + `layout.tsx` (metadata/JSON-LD, param-stripped canonical) + OG route + `sitemap.ts` entry. Run the `rpc-insights-qa` checklist before considering it done. Drill-down: `nft_id → /moment/<id>`, plus the outbound `listing_url`.
4. **Alert filters (second payoff)** — once the feed exists, wire the saved-but-inert subscription filters (`min_serial`/`max_serial`/`require_jersey_serial`/`require_last_mint`/`require_never_sold`/`require_low_ask`) into `build_deal_alerts_for_subscription` (a Cowork-shipped SECDEF fn reading `cross_collection_deals_board`). Lower priority + higher risk (touches the live alert path); do after the board ships.

## Guardrails
Direct-to-`main`, PowerShell git, full-file writes, Vercel `maxDuration` ≤ 800s. Insights surfaces → `rpc-insights-qa`. The TS public-api GQL has introspection disabled and returns inconsistent "unknown field" errors — capture real queries rather than reverse-engineering blind.
