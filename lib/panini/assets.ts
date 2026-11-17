// lib/panini/assets.ts
//
// Panini WC Prizm media (card thumbnails, card videos, pack art) are stored as
// RELATIVE paths — "pack/1038/thumbnail/…png", "challenge/4772/…mp4",
// "pack/pack_enh_bc_1038.png" — on all 5,101 panini_editions rows and in
// panini_pack_state.raw. Until 2026-09-27 no host was known, so every surface
// rendered no image rather than guess one (a relative src is requested from OUR
// domain and 404s).
//
// ── THE HOST IS MEASURED, NOT GUESSED (2026-09-27, via pg_net from the DB) ──
// Panini's own SPA bundles (nft.paniniamerica.net/js/index-*.js) build media
// URLs on https://assets.paniniamerica.net/catalog/product/. Against that base:
//   · 50 of 50 random panini_editions thumbnails → 200 image/png (40 `pack/…`,
//     10 `challenge/…`, the only two path shapes present)
//   · 15 of 15 random video_url → 200 video/mp4
//   · the pack art path → 200 image/png
//   · negative control, a path that does not exist → 403 (so the host is not a
//     catch-all that would answer 200 for anything)
// A path at the bare host root (no /catalog/product/) → 403: the prefix matters.
//
// Anything that is not a plain relative path (an absolute URL, a protocol-
// relative "//", a leading "/", a "..", odd characters) is refused → null, so a
// bad row renders as "no image", never as a request to an arbitrary host.

export const PANINI_ASSET_BASE = "https://assets.paniniamerica.net/catalog/product/"

// Same character set as the SQL twin `public.panini_asset_url` (migration
// 20260927190000), which also writes these URLs into `editions` — measured: all
// 5,101 stored paths fit it, none carries a space, "..", or "//".
const RELATIVE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

/**
 * Absolute URL for a stored Panini media path, or null when it is absent or not a
 * safe relative path. IDEMPOTENT: a URL already on the Panini base passes through
 * (editions.thumbnail_url holds absolute URLs since 20260927190000, while
 * panini_editions still holds the relative source paths).
 */
export function paniniAssetUrl(path: string | null | undefined): string | null {
  if (typeof path !== "string") return null
  const p = path.trim()
  if (!p || p.includes("..")) return null
  if (p.startsWith(PANINI_ASSET_BASE)) {
    const rest = p.slice(PANINI_ASSET_BASE.length)
    return RELATIVE_PATH.test(rest) && !rest.includes("//") ? p : null
  }
  if (!RELATIVE_PATH.test(p) || p.includes("//")) return null
  return PANINI_ASSET_BASE + p
}
