# Pinnacle Direct Integration — Research

Date: 2026-05-09
Author: Claude Code (research only, no implementation)
Status: Open — recommendation pending eng review

## 1. Current state

Disney Pinnacle data flows through Flowty's `flowty-proxy` Supabase edge function. The proxy is rate-capped at 100 listings per page and returns marketplace ASK prices that uniformly collapse to a `$1` floor across the entire 10K+ catalog. The Flowty Pinnacle pipeline emits `upstream_floor_only=true` on every batch, which means the prices coming out are **not usable as ASK signals** — they reflect a Flowty-side artifact, not real seller behavior.

Consequence: every Pinnacle FMV in `fmv_snapshots` that traces back to an ASK proxy is suspect. Pinnacle sniper deals against `cached_listings` are unreliable. The May 8 Pinnacle backfill chain shipped, but it's blind to live listing pressure.

## 2. Web research findings

What I checked and what came back:

- `https://disneypinnacle.com/api/*` — 403 Forbidden on every probe (root, `/listings`, `/marketplace`, `/moments`, `/pins`)
- `https://api.disneypinnacle.com/*` — same 403 wall
- Public docs / developer hub — none. Disney Pinnacle has no developer-facing API surface. The product is mobile-first (iOS, Android), with a web companion added later that talks exclusively to private endpoints behind Cloudflare.
- GraphQL probe (`/graphql`, `/api/graphql`, `/v1/graphql`) — all 403 / 404
- No public RSS, no announced webhook, no partner program. Dapper has not exposed a Pinnacle equivalent of Top Shot's `public-api.nbatopshot.com/graphql`.

Conclusion: there is no public REST or GraphQL surface to integrate against today. Anything we build has to read from the chain, not from Disney's web infrastructure.

## 3. Recommended path forward

Listen to the chain. Pinnacle's marketplace activity is on Flow at contract `0xedf9df96c92f4595`. Every mint, withdraw, deposit, and (if there's a marketplace contract) listing/sale event surfaces in Cadence event logs. We can subscribe to those via Flow REST API event streaming, parse them in a Cloudflare Worker, and ingest into Supabase as a first-class data source — same shape as the existing `flowty_transactions` indexer.

Architecture sketch:

- New Cloudflare Worker (`pinnacle-events-proxy.tdillonbond.workers.dev`) sitting in front of `rest-mainnet.onflow.org` and the historical spork access nodes (port 8070, same pattern as the planned `flow-spork-proxy` worker for the AllDay/Pinnacle backlog scan).
- The worker calls `getEventsForBlockHeightRange(eventType, startHeight, endHeight)` on Pinnacle's contract, encoded with `Buffer.from(str, 'utf8').toString('base64')` for the Cadence script body (NOT `btoa()` — Unicode breaks).
- Events of interest: `Pinnacle.Mint`, `Pinnacle.Withdraw`, `Pinnacle.Deposit`. If the marketplace lives in a sibling contract (open question, see §6), the listing/sale event types from there as well.
- A Supabase edge function `pinnacle-event-ingest` polls the worker every 2-5 minutes, walks new block ranges since last cursor, decodes events, writes into a new `pinnacle_marketplace_events` table.
- A second pass reconciles `pinnacle_marketplace_events` against `pinnacle_sales` and the existing `pinnacle_editions` for FMV recalc.

Same operational shape as the existing `topshot-proxy`, `allday-proxy`, `hybrid-custody-proxy` workers — shared `X-Proxy-Secret = TS_PROXY_SECRET` rotation surface, no new auth model.

## 4. Required Cadence scripts

Stub names only — implementations to come, verified against deployed contract source via the Cadence MCP per CLAUDE.md.

- `getCollectionLength` — count of NFTs held by an account, used for paginated scan boundary checks.
- `getMomentMetadata` — given a Pinnacle NFT id, return character_name, set_name, variant_type, edition_key, plus any Pinnacle-native trait surface (studio, materials, effects, size, color, thickness — see `pinnacle_editions` columns).
- `getMarketplaceListings` — current open listings, returning (listing_id, seller, price, currency, expires_at). Cardinality matters: confirm whether listings are on-chain (resource-based, like NFTStorefrontV2) or off-chain (Disney-side database).
- `getRecentSales` — completed sales over a block height range. May overlap with the event-stream ingest path; useful as a backfill primitive for the spork scan.

## 5. Cost estimate

- One new Cloudflare Worker — free tier handles the volume; same pattern as 7 existing workers.
- One new Supabase table `pinnacle_marketplace_events` — small, partition by month if volume warrants.
- Possibly a new pipeline_runs entry per ingest tick.
- Engineering: roughly **2-3 days to MVP**. Day 1 = worker + Cadence scripts, day 2 = ingest function + table + cron, day 3 = reconcile against `pinnacle_sales` and wire FMV recalc. No dependency on R1 or R2.

## 6. Open questions

- **Does Pinnacle have a marketplace contract address separate from `0xedf9df96c92f4595`?** Top Shot uses NFTStorefrontV2 at `0x4eb8a10cb9f87357` (Dapper) for listings, distinct from the moment contract. Pinnacle may follow the same pattern (Dapper marketplace at the same `0x4eb8a10cb9f87357`?) or have its own. Cadence MCP introspection on the deployed contract source will answer this — do that before writing event subscribers.
- **What is the Cadence schema for Pin metadata?** `pinnacle_editions` has 23 columns suggesting rich on-chain traits (royalty_code, variant_type, printing, size, color, thickness, materials, effects). Confirm whether these come from MetadataViews.Display + custom Traits, or whether some are Disney-side enrichment. The latter blocks full direct integration.
- **Are listings on-chain or off-chain?** If marketplace state lives only in Disney's private database, event subscription gives us sales but not active listings — which means the $1 floor problem remains for any "current ASK" UI. If they're on-chain (NFTStorefrontV2 resource pattern), we get both for free. This is the highest-leverage question to resolve first — if listings are off-chain, the integration shape changes substantially (we'd need transitions/sales as the only signal and infer "ASK pressure" from withdraw/deposit cadence).
- Do withdraw events distinguish "moved to internal vault for hold" from "listed for sale"? If not, ASK inference from deposit/withdraw is noisy.
- Does Disney use HybridCustody for parent/child Pinnacle accounts? `hybrid_custody_events` already indexes this for Top Shot — we'd want the same for Pinnacle so leaderboards collapse parent + child correctly. Check `linked_accounts` after we have one Pinnacle ingest tick run.

## Followups for the actual implementation pass

- Confirm question 6.3 first — that's the gate.
- Use Cadence MCP to fetch `Pinnacle.cdc` source from `0xedf9df96c92f4595` and audit the event surface before designing tables.
- Coordinate with the spork-scan worker (planned in CLAUDE.md "Known issues" item 7) — both want port 8070 access and could share a worker.
