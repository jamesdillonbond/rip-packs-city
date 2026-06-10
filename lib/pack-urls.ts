// lib/pack-urls.ts
// Outbound URL builders for pack distribution pages on the upstream marketplaces.
// Centralized so we can iterate the exact URL shape in one place when upstream
// rotates patterns (Top Shot did exactly this in May 2026 — the old
// `https://nbatopshot.com/listings/p2p?packListingId=<uuid>` returns dead).

/**
 * Top Shot pack URL.
 *
 * When a `packListingUuid` is present we return the verified secondary
 * marketplace listing page:
 *   https://nbatopshot.com/marketplace/packs/listing/<packListingUuid>/<distId>
 * Verified by Trevor 2026-06-09 (live "BUY FOR $X" button + listings depth on
 * dist 5427, packListingUuid c1891905-0f26-4fc2-9678-a4df51f2cbe2 — exactly the
 * `packListingId` our live-pack-listings aggregation returns per dist).
 *
 * Without a uuid we fall back to `https://nbatopshot.com/drop/<distId>`, the
 * primary drop-page pattern. The old `?packListingId=<uuid>` query-string form
 * is dead; see docs/handoff-2026-05-26b-remaining-work.md Phase 4 for context.
 */
export function topshotPackUrl(opts: { distId: string; packListingUuid?: string | null }): string {
  if (opts.packListingUuid) {
    return `https://nbatopshot.com/marketplace/packs/listing/${encodeURIComponent(
      opts.packListingUuid,
    )}/${encodeURIComponent(opts.distId)}`
  }
  return `https://nbatopshot.com/drop/${encodeURIComponent(opts.distId)}`
}

/**
 * NFL All Day pack listing URL.
 *
 * UNVERIFIED in production (2026-06-09): this `/pack/<id>` shape has never been
 * exercised against a live AllDay secondary listing — Cloudflare 403s automated
 * fetches and we had no live AllDay listing to confirm against. The Pack Sniper
 * AllDay path stays effectively dark until this is browser-verified; once it is,
 * fix the shape (and/or the `packListingId` vs `distId` choice) HERE in one
 * place — this is the only caller-facing definition.
 */
export function alldayPackUrl(opts: { packListingId: string }): string {
  return `https://nflallday.com/pack/${encodeURIComponent(opts.packListingId)}`
}

/**
 * dapper.market pack deep link (the secondary marketplace surface).
 *
 * Shape browser-verified 2026-06-09 (anon Chrome, real clicks): opens a Pack
 * Details modal for exactly that distribution (supply, pack odds, lowest ask,
 * listed count, and a working "Buy Pack for $X" button when listed there).
 * Verified against our own pack_distributions by title match — TS packDetail
 * 8524 / 5427, AllDay packDetail 7578.
 *
 * CAVEAT (also verified): dapper.market displays a SUBSET of the Dapper Studio
 * listing book our Pack Sniper feed reads — ~833 NBA packs browsable vs ~1,901
 * dists with live listings in our aggregation. So a dapper.market link can land
 * on a "No packs listed" modal for a deal our board shows from the fuller book.
 * nbatopshot.com/drop/<distId> (native P2P, same book as the Studio aggregation)
 * remains the best-odds primary; it just can't be automation-verified
 * (Cloudflare) — pending one human click.
 */
export function dapperMarketPackUrl(opts: { league: "nba" | "nfl"; distId: string }): string {
  return `https://dapper.market/${opts.league}/search/packs?packSource=marketplace&packDetail=${encodeURIComponent(opts.distId)}`
}
