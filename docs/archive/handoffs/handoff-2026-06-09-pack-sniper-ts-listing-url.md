# Handoff 2026-06-09 — Pack Sniper final polish: verified TS marketplace listing URL + listingCount honesty

Audience: Claude Code. Direct-to-main, no branches, no PRs. Tiny session — two small items. Follows 53c2354 + add59fa.

Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.

## Context

Trevor human-verified the native TS secondary pack URL (screenshot, 2026-06-09): https://nbatopshot.com/marketplace/packs/listing/c1891905-0f26-4fc2-9678-a4df51f2cbe2/5427 renders the 2025 NBA Finals: Rare Hit listing page with a live "BUY FOR $59.00" button, 11 For Sale, and a listings depth chart. The shape is /marketplace/packs/listing/<packListingUuid>/<distId> — and that uuid is exactly the packListingId our live-pack-listings helper already returns per dist (verified: our 5427 row carries packListingId c1891905-0f26-4fc2-9678-a4df51f2cbe2). This supersedes the best-effort /drop/<distId> guess and closes the TODO(2026-05-26) in lib/pack-urls.ts.

The same screenshot exposed a board honesty bug: TS shows 11 For Sale on 5427 but our board's LISTINGS column says 1. Cause: searchPackNftAggregation returns ONE aggregated node per dist (1,901 nodes = 1,901 distinct dists, measured), so the route's per-dist node count is always 1. The listingCount field is structurally meaningless.

## Item 1 — topshotPackUrl: use the verified marketplace listing shape

lib/pack-urls.ts: topshotPackUrl already accepts { distId, packListingUuid? }. Change the body: when packListingUuid is present return https://nbatopshot.com/marketplace/packs/listing/<packListingUuid>/<distId> (encodeURIComponent both); else fall back to the existing https://nbatopshot.com/drop/<distId>. Replace the TODO + "pending human verification" header comments with: verified by Trevor 2026-06-09 (live BUY button on 5427).

Callers to check (grep topshotPackUrl): components/packs/PackPageClient.tsx already passes packListingUuid from the live overlay. lib/packs/pack-deals.ts builds buyUrl from the live listing — make sure it passes the listing's packListingId through so deal rows get the marketplace URL, not the /drop fallback. dapperUrl handling unchanged (TS rows keep the dual link).

Revert: git revert.

Verify: tsc clean; deploy READY; anon feed row for a listed TS dist shows buyUrl of the marketplace/packs/listing shape with both ids; clicking it from the board lands on a buyable listing page.

## Item 2 — retire the misleading LISTINGS column

The aggregation gives min ask per dist but NOT a listing count (always 1 node per dist). Options in order of preference:

2a (preferred, smallest): remove the LISTINGS column from app/insights/pack-sniper/PackSniperClient.tsx and drop listingCount from the deal payload in lib/packs/pack-deals.ts (keep it in the internal live-pack-listings shape for compatibility — /api/pack-listings consumers like PackPageClient still read it; just stop presenting it as truth on the public board). Note the always-1 fact in a comment at the listingCount definition in lib/packs/live-pack-listings.ts so nobody re-trusts it.

2b (only if trivially available): the TS page's "11 For Sale" likely comes from getPackListing dynamic data or a non-aggregated pack search; do NOT add a second upstream query for a cosmetic count — that's how cosmetic counts become new failure surfaces. If a real count isn't already in the response we have, ship 2a.

Revert: git revert.

Verify: board renders without the column; tsc clean; smoke green.

## Guardrails

Direct-to-main; PowerShell git commit; re-verify push with git rev-list --count origin/main..HEAD (expect 0); full-file writes (CRLF); after deploy confirm READY + smoke + no new Sentry.

## Expected end state

One commit on main, deploy READY: TS View Listing links land on the actual buyable marketplace listing page (verified shape), lib/pack-urls.ts TODO closed, and the board no longer shows a structurally-always-1 LISTINGS count. Pack Sniper fully closed out.
