// lib/trophy/slab-href.ts
//
// Where a pinned trophy slab links.
//
// Every Flow/Solana trophy is a Moment with an RPC moment page (`/moment/<id>`).
// A Panini trophy is not: its moment_id is a Panini card SKU
// (`packcard-…__<serial>_<cap>`), and RPC has no per-card page — `/moment/<sku>`
// resolves nothing and 404s. So a Panini slab links to the card's edition on
// Panini's own marketplace (the same page the Panini edition page and the Panini
// sniper link to), in a new tab. A Panini slab whose edition key is not a
// Panini SKU gets NO link rather than a dead one.

import { paniniEditionUrl } from "@/lib/panini/edition-url"

export const PANINI_COLLECTION_ID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

export type TrophySlabHref =
  | { kind: "internal"; href: string }
  | { kind: "external"; href: string }
  | { kind: "none" }

export function trophySlabHref(slab: {
  moment_id: string
  collection_id: string | null
  collection_slug?: string | null
  edition_id?: string | null
}): TrophySlabHref {
  const isPanini =
    slab.collection_id === PANINI_COLLECTION_ID || slab.collection_slug === "panini_blockchain"
  if (isPanini) {
    const url = paniniEditionUrl(slab.edition_id ?? null)
    return url ? { kind: "external", href: url } : { kind: "none" }
  }
  return { kind: "internal", href: "/moment/" + slab.moment_id }
}
