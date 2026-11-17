// lib/hero-srcset.ts
//
// 2026-10-21 (Lighthouse, mobile): the edition page's LCP element is the hero
// image, at LCP 5.4 s ("poor"). It was ONE fixed width — 960 px from our IPFS
// resizer (142 KB) or 1080 px from Top Shot's CDN (73 KB) — painted into a
// 318 px box on a phone and a 320 px column on desktop. Measured on one hero:
// ipfs-thumb 320/640/960 = 28/80/142 KB; Top Shot CDN 320/640/1080 = 10/27/73 KB.
//
// `heroSrcSet` returns a srcset for the two resizable hero sources, so the
// browser fetches the width the box needs at its DPR (React 19 carries it into
// the hero's `<link rel="preload" imagesrcset>`). Any other URL → null and the
// <img> keeps its single src, exactly as before.

import { IPFS_THUMB_WIDTHS } from "@/lib/ipfs-media"

// 2026-10-26: the arweave resizer (Candy MLB art) takes the same widths.
const IPFS_THUMB_RE = /^(\/api\/public\/(?:ipfs-thumb\/[A-Za-z0-9]+|arweave-thumb\/[A-Za-z0-9_-]{43}))\?w=\d+$/
const TOPSHOT_MEDIA_RE = /^(https:\/\/assets\.nbatopshot\.com\/media\/\d+\/image)\?width=\d+$/
const TOPSHOT_WIDTHS = [320, 640, 1080] as const

/** The `sizes` for the edition hero box: it is `maxWidth: 320` at every viewport
 *  (a 318 px box on a 412 px phone), so 320 CSS px × DPR picks the width. */
export const ENTITY_HERO_SIZES = "320px"

export function heroSrcSet(url: string | null | undefined): string | null {
  if (!url) return null
  const ipfs = IPFS_THUMB_RE.exec(url)
  if (ipfs) return IPFS_THUMB_WIDTHS.filter((w) => w >= 320).map((w) => `${ipfs[1]}?w=${w} ${w}w`).join(", ")
  const ts = TOPSHOT_MEDIA_RE.exec(url)
  if (ts) return TOPSHOT_WIDTHS.map((w) => `${ts[1]}?width=${w} ${w}w`).join(", ")
  return null
}
