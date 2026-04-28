// Flowty marketplace deep-link helpers.
//
// The Flowty asset URL pattern is consistent across every collection
// they index — only the contract address + name change. The patterns
// below mirror what the listing-cache routes already use so a click
// from /analytics/listings lands on exactly the same asset page a
// click from /[collection]/collection would.
//
// Pinnacle is intentionally absent — it lives on a separate marketplace
// with no Flowty-side equivalent, so callers should treat the helper's
// null return as "no external deep-link available" and render a plain
// label instead.

const ASSET_BASES: Record<string, string> = {
  topshot: "https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/",
  allday: "https://www.flowty.io/asset/0xe4cf4bdc1751c65d/AllDay/NFT/",
  golazos: "https://www.flowty.io/asset/0x87ca73a41bb50ad5/Golazos/NFT/",
  ufc: "https://www.flowty.io/asset/0x329feb3ab062d289/UFC_NFT/NFT/",
}

const COLLECTION_ALIASES: Record<string, string> = {
  topshot: "topshot",
  nba_top_shot: "topshot",
  "nba-top-shot": "topshot",
  allday: "allday",
  nfl_all_day: "allday",
  "nfl-all-day": "allday",
  golazos: "golazos",
  laliga_golazos: "golazos",
  "laliga-golazos": "golazos",
  ufc: "ufc",
  ufc_strike: "ufc",
  "ufc-strike": "ufc",
  pinnacle: "pinnacle",
  disney_pinnacle: "pinnacle",
}

export function normalizeCollectionSlug(raw: string | null | undefined): string | null {
  if (!raw) return null
  const lower = String(raw).trim().toLowerCase()
  return COLLECTION_ALIASES[lower] ?? lower
}

// Returns the Flowty asset URL for a given (collection, nftId) pair, or
// null when no Flowty equivalent exists (Pinnacle, unknown collections).
export function flowtyListingUrl(
  collection: string | null | undefined,
  nftId: string | number | null | undefined,
  listingResourceId?: string | number | null
): string | null {
  const slug = normalizeCollectionSlug(collection)
  if (!slug) return null
  const base = ASSET_BASES[slug]
  if (!base) return null
  if (nftId == null || nftId === "") return null
  const id = String(nftId)
  if (listingResourceId != null && listingResourceId !== "") {
    return `${base}${encodeURIComponent(id)}?listingResourceID=${encodeURIComponent(String(listingResourceId))}`
  }
  return `${base}${encodeURIComponent(id)}`
}
