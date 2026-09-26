// lib/pinnacle/image-url.ts
//
// Pinnacle art is served through our own resolver, /api/public/pinnacle-image/<render_id>,
// which mints a fresh signed Dapper CDN URL. `?v=thumb` asks it for the cropped render:
// measured 2026-09-26 on one render, Front_Cropped is 284,505 bytes against
// 1,144,333 for the full 2880px Front_Transparent. A Market page shows 50.

const RESOLVER_RE = /^\/api\/public\/pinnacle-image\/[A-Za-z0-9-]{3,64}$/

/**
 * The list-thumbnail form of a stored Pinnacle thumbnail URL. Only a bare resolver
 * URL gets the variant; anything else (an absolute CDN URL, an already-varianted
 * URL, null) passes through unchanged.
 */
export function pinnacleListThumb(url: string | null | undefined): string | null {
  if (!url) return null
  return RESOLVER_RE.test(url) ? `${url}?v=thumb` : url
}

/**
 * The Pinnacle contract returns ONE generic placeholder ("…/on-chain/pinnacle.jpg")
 * as the display image of EVERY NFT, and Flowty relays it as `card.images[0]`.
 * It is never a pin's art, so a writer must treat it as absent — never store it.
 */
export function isPinnaclePlaceholderImage(url: string | null | undefined): boolean {
  return !!url && /\/on-chain\/pinnacle\.jpg(\?|#|$)/i.test(url)
}
