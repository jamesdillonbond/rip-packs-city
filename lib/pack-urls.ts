// lib/pack-urls.ts
// Outbound URL builders for pack distribution pages on the upstream marketplaces.
// Centralized so we can iterate the exact URL shape in one place when upstream
// rotates patterns (Top Shot did exactly this in May 2026 — the old
// `https://nbatopshot.com/listings/p2p?packListingId=<uuid>` returns dead).

/**
 * Top Shot pack URL.
 *
 * Best-effort: this returns `https://nbatopshot.com/drop/<distId>`, which is
 * the URL used by Top Shot's primary drop pages and the most stable pattern
 * we know of. For sold-out drops or secondary p2p listings, the URL may
 * 404 — pending human verification of TS's current secondary URL shape.
 *
 * The previous `?packListingId=<uuid>` query-string form is dead; see
 * docs/handoff-2026-05-26b-remaining-work.md Phase 4 for context.
 */
export function topshotPackUrl(opts: { distId: string; packListingUuid?: string | null }): string {
  // TODO(2026-05-26): verify the URL still resolves for sold-out drops.
  // If TS rotates again, swap to the verified pattern here in one place.
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
