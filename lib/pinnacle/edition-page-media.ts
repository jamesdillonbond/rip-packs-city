// lib/pinnacle/edition-page-media.ts
//
// Fallback image source for /api/public/pinnacle-image/<renderId> (2026-11-15).
//
// The resolver asks Dapper's studio-platform `searchPinnacleEditions` for a fresh signed
// media URL. Renders that search has NO record of — the 31 `flow-chain` and 24
// `pinnacle-edition-page` catalog rows (Walt Disney Mugs Vol.1, Stitch in Costume Vol.1,
// A Disney Villains Halloween Vol.2, Trading Event Vol.2, …), still absent a week after
// mint — 404ed on every request, so 843 held pins in ~30 wallets showed placeholder art.
// Measured 11-15: the edition search and `searchPinnacleNft` both return 0 for them,
// while Pinnacle's OWN edition page (`https://disneypinnacle.com/edition/<edition_id>`,
// 200 from datacenter egress) embeds the same signed asset URLs the official site loads:
//   https://assets.disneypinnacle.com/render/<renderId>/front.png?exp=<unix>&sig=<hex>
// valid ~24 h.
//
// ⚠ The page ALSO embeds other pins' assets (related pins: 2 others on edition 2917), so a
// URL is accepted only when its PATH names this render — never the first asset on the page.

export type PinnacleImageVariant = "front" | "quarter" | "thumb"

// File names on the asset CDN, by the studio media name the main resolver prefers
// (front.png = Front_Transparent, main.png = Front_Quarter_Transparent,
// front_cropped.png = Front_Cropped — same mapping as the route header).
const FILE_ORDER: Record<PinnacleImageVariant, string[]> = {
  front: ["front.png", "main.png", "front_cropped.png"],
  quarter: ["main.png", "front.png", "front_cropped.png"],
  thumb: ["front_cropped.png", "front.png", "main.png"],
}

const RENDER_ID_RE = /^[A-Za-z0-9-]{3,64}$/

export interface EditionPageMedia {
  url: string
  /** Signature expiry, unix seconds. */
  exp: number
}

/**
 * Pick this render's signed asset URL for `variant` out of an edition page's HTML.
 * Returns null when the page carries no asset for THIS render (never another pin's).
 */
export function signedMediaFromEditionPage(
  html: string,
  renderId: string,
  variant: PinnacleImageVariant,
): EditionPageMedia | null {
  if (!html || !RENDER_ID_RE.test(renderId)) return null
  // renderId passed the allowlist above, so it holds only [A-Za-z0-9-] — no regex metacharacters.
  const re = new RegExp(
    `https://assets\\.disneypinnacle\\.com/render/${renderId}/([a-z_]+\\.png)\\?exp=([0-9]{9,11})(?:\\\\u0026|&amp;|&)sig=([0-9a-f]{16,128})`,
    "g",
  )
  const found = new Map<string, EditionPageMedia>()
  for (const m of html.matchAll(re)) {
    const [, file, exp, sig] = m
    if (!found.has(file)) {
      found.set(file, {
        url: `https://assets.disneypinnacle.com/render/${renderId}/${file}?exp=${exp}&sig=${sig}`,
        exp: Number(exp),
      })
    }
  }
  for (const file of FILE_ORDER[variant]) {
    const hit = found.get(file)
    if (hit) return hit
  }
  return null
}
