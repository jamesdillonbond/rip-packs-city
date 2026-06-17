# Handoff 2026-06-16 — Per-serial TS listings: use the public Dapper Atlas API (dapper.market's backend)

This SUPERSEDES the "capture the nbatopshot `searchMarketplaceListings` query" step in `docs/handoff-2026-06-16-underpriced-serials-deal-board.md`. That path is a dead-end; dapper.market gives a clean public source for the per-serial TS asks the **Underpriced #1s deal board (Item 2)** needs. The `topshot_active_listings` table + `topshot_underpriced_serials_board` view are already shipped (CC) and waiting on exactly this feed.

## ⚠ DECISION GATE — do NOT build the ingest without Trevor's explicit go-ahead

There is a **standing decision (2026-06-08, Trevor's)** to **DEFER any Dapper Atlas-API ingest** — rationale: RPC is pre-traction (~2 WAU, the funnel is the bottleneck, not data depth), Atlas is an undocumented/private API = a fragile solo-dev dependency, and the original motivation (a cosmetic dapper-link 404, gracefully covered by the native fallback) didn't justify it. Defined revisit triggers: RPC ≥~50 WAU + investing in FMV depth; Dapper volume grows beyond TS; users report dead links; or cross-market pricing becomes a flagship feature. Full reasoning: `docs/strategy/dapper-second-source-decision-2026-06-08.md`. The Atlas API + its fragility are already in memory.

The deal board is a NEW motivation (a serial-intelligence moat surface, not the 404-fix), but the SAME fragility/pre-traction caveat applies. So: confirm with Trevor that the deal board is worth standing up + maintaining a private-Atlas-API ingest now, before building. Everything below is the precise plan IF greenlit.

## The finding (verified live via dapper.market in-browser)

dapper.market — Top Shot's live post-Flowty secondary marketplace — is **accessible** (the agent browser blocks nbatopshot.com but NOT dapper.market) and exposes **per-serial listings** for every edition. Read live off a LeBron James "2026 NBA Playoffs · Hardcourt" edition (`#/50 LE`):

> Lowest Ask **$40** · Avg Sale **$67.45** · **5 listed (10%)**
> Serial → Listing Price: **#15 $40 · #25 $40 · #10 $49 · #8 $69 · #50 (perfect) $350**

That's precisely the shape `topshot_active_listings` was built for (`serial_number, ask_usd, listing_resource_id, …`), including the perfect-mint (`#50/50`).

## The source — the public Dapper Labs Atlas API

dapper.market's backend (captured from its network tab) is **`https://api.production.atlas.dapperlabs.com/public/atlas.v1.*`** — a **public** (`/public/` path), structured **Connect-RPC** API (POST, JSON/proto). Confirmed services/methods firing on an edition page:

- `atlas.v1.SetService/GetSet`
- `atlas.v1.EditionService/SearchEditions`
- `atlas.v1.EditionService/GetEdition`
- `atlas.v1.EditionService/GetEditionTopCollectors`
- `atlas.v1.MarketplaceService/SearchMarketplaceTransactions`  ← sales (confirmed)

## ✅ CAPTURED 2026-06-16 — the exact per-serial listings call (no guessing required)

Captured **programmatically from dapper.market's own page context** via the agent browser (a `fetch` interceptor installed on the live page, then triggered by selecting an edition) — so these are the REAL request/response shapes, headers and all. The repo's recurring "guess the schema" failure class is fully avoided.

**The per-serial active-listings feed is `MarketplaceService/SearchMarketplaceTransactions` with `completed:false`** (NOT a separate `SearchMarketplaceListings` — that method name was a wrong guess). The SAME method with `completed:true` returns sales — so this one call is both the listings feed AND a clean second-source sales feed.

**Endpoint:** `POST https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions`

**Request headers** (the only two the page sets explicitly): `connect-protocol-version: 1`, `content-type: application/json`. The browser auto-adds `Origin: https://dapper.market` + a real browser User-Agent — that's what the bare-curl 403 was missing (see egress note).

**Request body (plain JSON):**
```json
{"product":"nba","completed":false,"editionId":"2017","sortByOption":"PRICE","sortByDirection":"ASC","limit":"50","offset":"0","offers":false}
```
`completed:false` = active asks; `editionId` = Dapper's integer edition id (e.g. 2017 / 15335 — NOT the `setID:playID` key, see id-mapping note); `sortByOption:"PRICE"` + `sortByDirection:"ASC"` = cheapest-serial-first ladder; paginate via `limit`/`offset`.

**Response (per-serial rows — exactly the `topshot_active_listings` shape):**
```json
{"transactions":[
  {"uuid":"81856fd4-ffe2-5269-9e26-77d860ceeffa","priceCents":"59","sellerAddress":"1e73927ef8bbcb08","nftId":"4228988","nftType":"A.0b2a3299cc857e29.TopShot.NFT","serialNumber":"4303","completed":false,"purchased":false,"listedAt":"2026-06-16T22:33:34.455Z","edition":{"id":"2017","tier":"COMMON","maxMintSize":"35000","numMinted":"35000","set":{"id":"26","name":"Base Set"},"series":{"id":"2","name":"Series 2"}}},
  ...sorted by priceCents ASC...
]}
```
Field map → `topshot_active_listings`: `serialNumber`→`serial_number`, `priceCents`/100→`ask_usd`, `nftId`→`nft_id`, `uuid`→`listing_resource_id`, `sellerAddress`→seller, `listedAt`→`listed_at`. The **#1 ask** = the row where `serialNumber == "1"`; the **perfect-mint ask** = the row where `serialNumber == edition.numMinted`. Verified live: a real ladder came back ($0.59 floor across serials 4303/4314/4334/… for a Base-Set common; higher-value editions spread like the LeBron Hardcourt #/50 → $40/$49/$69/perfect $350).

**Companion methods captured** (for context): `EditionService/GetEdition` (req `{"editionId":"15335","product":"nba"}` → edition metadata: tier/maxMintSize/numMinted/set/series — **NO listings**); `EditionService/SearchEditions` (req `{"product":"nba","playerName":["LeBron James"],"hasListings":true,"sortByOption":"LOW_ASK","sortByDirection":"ASC","limit":"50","offset":"0"}` → edition-grid with an aggregate low-ask — **NOT per-serial**); `SetService/GetSet`; `EditionService/GetEditionTopCollectors`.

## ✅ FOLLOW-UP CAPTURE 2026-06-16 — egress, edition-join, serial targeting, PII (all resolved)

A Claude Code pass + a second agent-browser capture closed every remaining technical unknown. Net: the technical risk is retired; only the build go/no-go (the DECISION GATE above) remains.

- **Egress CONFIRMED (CC).** A plain server-side POST with `Origin: https://dapper.market` + `Referer` + a real browser `User-Agent` + the two Connect headers returns **HTTP 200 with the full ladder** — no Cloudflare JS challenge, no auth token, no cookie. This is a far easier class than the WAF-blocked nbatopshot/nflallday endpoints, and almost certainly works **directly from Vercel egress (no Worker needed)** — confirm from an actual Vercel function as the last 5%.
- **Edition-id join RESOLVED — don't map Atlas's `editionId` at all.** Every listing row carries `nftId` (the on-chain moment id, e.g. 4228988) + `nftType: A.0b2a3299cc857e29.TopShot.NFT`. RPC already indexes that on-chain moment id (`moments`/`sales`/`wmc` → `edition_key`), so join **per row via `nftId` → RPC edition**, sidestepping Atlas's fragile internal `editionId` entirely. (Rows also carry `set.id`/`set.name`, `editionTemplate.metadata.PlayerId` = NBA-stats id, `DateOfMoment` as secondary signals — but `nftId` is the clean one.)
- **Serial #1 / perfect-mint targeting SOLVED — bounded at ~2 cheap calls/edition, independent of listing count.** Captured the real serial sort from the listings table's "Serial" column header: **`sortByOption:"SERIAL_NUMBER"`** (with `sortByDirection` ASC/DESC). So per candidate edition: one `{sortByOption:"SERIAL_NUMBER", sortByDirection:"DESC", limit:"1"}` → the highest listed serial (the **perfect mint** when it `== numMinted` — live-verified: returned serial 35000 @ $19.99 on a 2,796-listing common in a single call), and one `ASC, limit:"1"` → the lowest listed serial (the **#1** when it `== 1`). **Rule: accept the boundary row only if its `serialNumber` equals the target (1 / numMinted); otherwise that special serial simply isn't listed** (no board row). Pagination object is `{totalCount, limit, offset, hasMore}` (all strings). NOTE: my ASC `limit:1` re-probe came back empty under rate-limiting (6 rapid probes tripped a soft throttle — 200 with empty `transactions`); re-verify the ASC #1-end once from the build with gentle cadence. The candidate set (scarce/LE editions with non-null serial-FMV) has FEW listings anyway, so a single `limit:50` page per edition also gets both ends cheaply — the SERIAL_NUMBER `limit:1` boundary trick is the optimization for any high-listing candidate.
- **PII storage caution (CC).** The response embeds seller PII — `seller.dapperId` (auth0 id), `seller.username`, `seller.profileImageUrl`. **Store only `sellerAddress`/`flowAddress`; drop the rest.**

(Historical note — superseded: the earlier draft listed Atlas-edition-id mapping as "the one remaining field question." Resolved above via `nftId`.)

## Precise remaining work

1. ✅ **DONE — method + request body + response shape + headers all captured above** (2026-06-16, programmatically from dapper.market's page context). No manual DevTools capture needed. The only residual schema question is the Atlas-edition-id → RPC-edition join (see the ⚠ note above) — resolve that during the ingest build.
2. **Verify egress.** `api.production.atlas.dapperlabs.com` is a DIFFERENT host from the WAF-blocked `nflallday.com` / TS website endpoint, and it's public — so it's likely reachable from Vercel egress (prefer Vercel, like `topshot-sales-history-backfill`). Confirm a server-side POST succeeds before building the cron. Be gentle with cadence — dapper.market's own RSC calls 503'd under rapid clicks, so the Atlas API likely rate-limits.
3. **Build the ingest** `/api/cron/topshot-active-listings-ingest` (mirror the `topshot-sales-history-backfill` safety pattern: synchronous self-budget under 300s, idempotent, logs `pipeline_runs`, `?dryRun`). Candidate editions = those where `serial_fmv_estimate` returns a non-null #1/perfect estimate. Per edition: Atlas `SearchMarketplaceListings` (filtered to that edition) → upsert the #1 and perfect-serial rows into `topshot_active_listings` (PK `(edition_id, serial_number)`); mark not-seen rows `active=false`.
4. **Then** the public page + alert filters per the original Item 2 handoff (the board view is already built and verified).

## Why this is the right source

- **Public + structured** (Connect-RPC, `/public/`) — unlike the nbatopshot public-api (introspection off, facet-shaped `searchMarketplaceListings`) and unlike the Cloudflare-blocked TS website marketplace endpoint.
- **It's Top Shot's actual current marketplace** (Dapper's own, post-Flowty) — the asks are real and authoritative, and it also carries AllDay + Golazos (same Atlas API, different league filter) — so this same ingest pattern can extend cross-collection later.
- Bonus parity: `MarketplaceService/SearchMarketplaceTransactions` is a clean public **sales** feed too — a potential more-robust replacement for the brittle nbatopshot-GQL sales path if ever wanted.

## Guardrails
Capture real Atlas payloads before coding (introspection/guessing is the repeated failure class). Direct-to-`main`, PowerShell git, full-file writes, Vercel `maxDuration` ≤ 800s. Insights surface → `rpc-insights-qa`. Be gentle with Atlas cadence (it rate-limits).
