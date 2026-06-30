# Handoff 2026-06-09 — Pack Sniper (TS + AllDay sealed-pack deal surface)

Audience: Claude Code on Trevor's machine. Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first. HEAD at handoff time: 7808f22.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Context

Trevor asked what it would take to build a "Pack Sniper" for NBA Top Shot + NFL All Day. Cowork scoping (2026-06-09, live DB + repo verification) found the infrastructure is ~90% built already — this handoff is the remaining ~10%, all code-side. NO DB migrations are required; everything ships through git.

What already exists (verified, do not rebuild):

- app/api/pack-listings/route.ts — live sealed-pack listings from Dapper Studio GQL (api.production.studio-platform.dapperlabs.com, searchPackNftAggregation), per-dist lowest ask + listing count + packListingId, BOTH nba-top-shot and nfl-all-day, reserve-owner excluded (secondary-only), 2-min in-memory cache. This endpoint already solves the two problems that looked gating (live asks + dist resolution at listing time — the listing node carries dist_id directly).
- pack_ev_latest / pack_table_rows — gross_ev, value_ratio, fmv_coverage_pct, freshness per dist. Measured 2026-06-09: TS 1,172 packs with EV (564 fresh <24h, 760 at >=80% FMV coverage); AllDay 521 (329 fresh, 515 at >=80%).
- pack_ev_history — already snapshots secondary_ask + price_source per EV tick (ask history exists, no new table needed).
- components/packs/PackPageClient.tsx — live-ask overlay that recomputes EV margin vs the live ask, +EV-only filter, value-ratio sort.
- lib/pack-urls.ts — topshotPackUrl (drop/<distId>, best-effort) + alldayPackUrl.
- Opportunity sizing (live query 2026-06-09): TS secondary sealed-pack sales 15,694 in 30d @ avg $38.86; of the dist-resolved subset with EV, 27% sold below 80% of gross EV. AllDay: 683 sales/30d @ avg $4.63 (thin — rides along, TS is the story).

The delta this handoff ships: a deal-FIRST public surface (rank by live ask vs EV with honesty gates), shared server-side deal logic, and outbound-link verification. Items in priority order.

## Item 0 — verification probes (run these first, adapt Items 1-4 to findings)

No files touched. Three probes:

0a. Hit /api/pack-listings in prod for both collections with Bearer INGEST_SECRET_TOKEN (route is not in the proxy.ts public list, so anon gets 302). PowerShell: Invoke-WebRequest https://www.rippackscity.com/api/pack-listings?collection=nba-top-shot with the Authorization header, then nfl-all-day. Record listings count per collection and confirm lowestAsk/distId/packListingId populate. If AllDay returns near-zero listings, ship Items 1-3 TS-only and leave the AllDay config in place (it costs nothing).

0b. Outbound URL check (browser): for one currently-listed sold-out TS pack from probe 0a, verify https://nbatopshot.com/drop/<distId> resolves to a page where the user can actually reach the secondary listing. Also check whether dapper.market has a sealed-pack listing URL pattern (it is the post-Flowty marketplace; packs may live there). If a better pattern exists, update topshotPackUrl in lib/pack-urls.ts — that is the single place the URL shape lives. Note the existing TODO(2026-05-26) in that file; this probe closes it.

0c. Same for AllDay: verify alldayPackUrl's nflallday.com/pack/<packListingId> against a live listing. PackPageClient.tsx line ~188 notes the AllDay buy link was never wired — Item 4 wires it once verified.

## Item 1 — shared deal-feed logic: lib/packs/pack-deals.ts (new file)

Why: the deal computation (live asks joined to EV with honesty gates) is needed by both the public insights route (Item 2) and the packs-page preset (Item 4). The fetch+aggregate logic currently lives inline in app/api/pack-listings/route.ts; do NOT duplicate it.

What: extract the Dapper Studio fetch + per-dist aggregation from app/api/pack-listings/route.ts into a shared helper (e.g. lib/packs/live-pack-listings.ts) that the existing route then imports — preserving its exact response shape and 2-min cache semantics (the cache Map moves into the helper). Then add lib/packs/pack-deals.ts exporting an async getPackDeals(collection) that:

- calls the shared live-listings helper for the collection
- reads pack_table_rows (or pack_ev_latest joined to pack_distributions — match whichever shape is cleaner, pack_table_rows already has everything) via supabaseAdmin for the same collection
- joins on dist_id and applies the honesty gates:
  - live lowestAsk > 0 (live listing required — never score against the cached/stale secondary_ask)
  - gross_ev IS NOT NULL and fmv_coverage_pct >= 80
  - ev_snapshotted_at within 72h
  - is_rare_single_pack = false (single-edition reward packs read as fake 30x deals)
  - exclude pack_type 'reward' rows with retail 0 only if they have no live ask anyway — a reward pack genuinely listed cheap below EV IS a deal; the gate that matters is the rare-single exclusion above
- computes liveValueRatio = gross_ev / lowestAsk and discountPct = 1 - (lowestAsk / gross_ev)
- sorts by liveValueRatio desc, returns top N (default 50) with: distId, title, tier, imageUrl, slots, lowestAsk, listingCount, grossEV, liveValueRatio, discountPct, fmvCoveragePct, evSnapshottedAt, buyUrl (via lib/pack-urls.ts), detailHref (/<collection>/pack/dist/<distId>), simulatorHref

RANK, DON'T PRICE (research-thread rule): the API returns the ratio but the UI (Item 3) presents ordering + "ask $X vs EV $Y" — never a headline "31x return!!" number. Weighted-EV artifacts on thin FMV make big ratios untrustworthy; the FMV-coverage chip and the simulator link are the honesty valves.

Revert: git revert the commit (new files + one import swap in pack-listings route).

Verify: npx tsc --noEmit clean; existing /api/pack-listings smoke check still passes (smoke-test route already asserts it returns 200-json).

## Item 2 — public deal feed route: app/api/public/insights/pack-sniper/route.ts (new file)

GET route, follows the existing /api/public/insights/squeeze pattern (app/api/public/insights/squeeze/route.ts — read it first and mirror auth/caching/filter conventions). Accepts ?collection=nba-top-shot|nfl-all-day (default nba-top-shot), optional tier / min_ratio / limit filters. Calls getPackDeals. Cache-Control s-maxage=300 (the upstream live-listings cache is 2 min; 5 min CDN cache keeps anon traffic off Dapper Studio entirely).

/api/public/* is already in the proxy.ts public bypass — no proxy.ts change needed for the API. Confirm with a grep before assuming.

Revert: git revert.

Verify: anon curl of https://www.rippackscity.com/api/public/insights/pack-sniper returns deals JSON in <2s.

## Item 3 — public board: app/insights/pack-sniper/page.tsx (new)

Follow the existing /insights board conventions exactly — read app/insights/squeeze/page.tsx (or the newest insights board) and mirror: server component, brand tokens (var(--rpc-red), var(--font-display), var(--font-mono) — never literals), Dataset/ItemList JSON-LD, canonical, OG card, drill-down links.

Content: ranked table of gated deals. Columns roughly: pack (image+title+tier chip), live ask, gross EV, EV freshness, FMV-coverage chip, listings count, View Listing (outbound, via buyUrl) + Details (pack dist page — already public for anon via the singular-entity isPublicPath rule) + Simulate. Per-row caveat treatment mirrors the pack dist page's verdict honesty (coverage <80 never appears here by gate, but show the coverage % anyway). Collection toggle TS/AllDay (hide AllDay if probe 0a found it empty).

Required chrome copy (honesty): a one-line methodology note that EV is a drop-weighted expectation, variance is huge, and the simulator shows the real distribution. Do not present the ratio as a return promise.

Also:
- Add the route to app/sitemap.ts alongside the other insights boards.
- Add a smoke-test check (app/api/smoke-test/route.ts) asserting the public route returns 200 + parseable rows array (can be empty — gates may legitimately pass 0 packs in a quiet market; assert shape, not count).
- proxy.ts: confirm /insights is already in the public bypass (the other boards are anon-reachable); if the path rule is per-board, add this one narrowly.
- Run the rpc-insights-qa checklist before calling it shipped (backing security N/A — no new view; smoke, sitemap, canonical, drill-downs, freshness display, brand).

Revert: git revert (page + sitemap + smoke entries are one commit).

Verify: anon load of /insights/pack-sniper renders ranked deals with working outbound + drill-down links; deploy READY; smoke green.

## Item 4 — packs-page deal preset + AllDay buy link (small, components/packs/PackPageClient.tsx + PackTable.tsx)

4a. Wire the AllDay buy URL: PackPageClient.toPackRow currently builds buyUrl only for nba-top-shot (line ~188). Once probe 0c verifies the URL shape, extend the conditional to nfl-all-day via alldayPackUrl({ packListingId: liveOverlay.packListingId }). If the verified AllDay URL needs distId instead, change alldayPackUrl's signature in lib/pack-urls.ts — it has zero other callers (verify with grep first).

4b. Optional one-evening polish, skip if anything above ran long: a "DEALS" quick-preset on the packs page — a chip next to the existing +EV-only toggle that applies posEvOnly + sort by live EV margin + gates matching Item 1, plus a link to /insights/pack-sniper. Keep it a preset over existing state, not a new data path.

Revert: git revert.

Verify: tsc clean; AllDay rows with live listings show a working View Listing link.

## Explicitly NOT in scope (do not build)

- No on-chain pack ListingAvailable cursor and no PackNFT.Minted dist-map worker — the Dapper Studio aggregation already provides live asks keyed by dist_id. (The Minted map is still worth doing someday for per-NFT sale enrichment — that is the separate pack-purchase-dist-bridge track, queued, not this.)
- No new ask-snapshot table or cron — pack_ev_history already records secondary_ask per EV tick; alerting/new-deal detection is deferred until the board proves usage (pre-traction restraint).
- No in-app buy (intelligence-first; outbound links only).
- No EV/FMV pricing-logic changes — the sniper only READS pack_ev_latest. FMV/ingest/pack-EV route logic stays off-limits per the autonomous-pass rules; nothing here touches it.

## Guardrails (repeat-every-handoff)

- Commit and push directly to main. No branches, no PRs. If the env pre-checks out claude/*, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s; anything higher sends the deploy to ERROR invisibly. (No route here should need anything near it.)
- CRLF: no string-replace patching; full-file writes or findIndex on split lines.
- Full file replacements, never snippets, per repo convention.
- After deploy: confirm deployment READY, run the smoke test, and check Sentry for new issues before closing.

## Expected end state

One or two commits on main, deploy READY: /insights/pack-sniper live for anon with gated TS (and, volume permitting, AllDay) sealed-pack deals ranked by live ask vs EV, outbound listing links verified (lib/pack-urls.ts TODO closed), AllDay buy link wired on the packs page, smoke + sitemap covering the new surface. Metric to watch: outbound_clicks rows with the new surface source, and whether the board passes >0 deals at typical gate settings (TS data says ~27% of dist-resolved secondary sales clear 80% of EV, so a populated board is expected).
