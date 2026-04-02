import type { PinnacleFlowtyListing, PinnacleFlowtyTrait } from "./types"
import { fetchPinnacleFlowtyListings } from "./flowty"

// Trait key variants used by Pinnacle NFTs on Flowty
const TRAIT_MAP: Record<string, string[]> = {
  pinName: ["PinName", "pinName", "Pin Name", "name"],
  setName: ["SetName", "setName", "Set Name"],
  rarity: ["Rarity", "rarity", "Tier", "tier"],
  series: ["SeriesNumber", "seriesNumber", "Series"],
  franchise: ["Franchise", "franchise", "Brand", "brand"],
}

function getTraitMulti(
  traits: PinnacleFlowtyTrait[] | undefined,
  keys: string[]
): string {
  if (!traits) return ""
  for (const key of keys) {
    const found = traits.find((t) => t.name === key)
    if (found?.value) return found.value
  }
  return ""
}

export interface PinnacleSyncItem {
  nftId: string
  pinName: string
  setName: string
  rarity: string
  franchise: string
  serial: number
  price: number
  listingResourceID: string
}

/**
 * Fetch and normalize Pinnacle listings from Flowty into a flat array
 * suitable for the sniper feed or DB sync.
 */
export async function syncPinnacleListings(): Promise<PinnacleSyncItem[]> {
  const pages = await Promise.all([
    fetchPinnacleFlowtyListings(0),
    fetchPinnacleFlowtyListings(24),
  ])
  const raw = pages.flat()
  const items: PinnacleSyncItem[] = []

  for (const listing of raw) {
    const order = listing.orders?.find((o) => (o.salePrice ?? 0) > 0) ?? listing.orders?.[0]
    if (!order?.listingResourceID || order.salePrice <= 0) continue

    // nftView is nested under listing.nft
    const traits = listing.nft.nftView?.traits?.traits ?? []
    const nftId = String(listing.nft.id)

    items.push({
      nftId,
      pinName: getTraitMulti(traits, TRAIT_MAP.pinName),
      setName: getTraitMulti(traits, TRAIT_MAP.setName),
      rarity: (getTraitMulti(traits, TRAIT_MAP.rarity) || "COMMON").toUpperCase(),
      franchise: getTraitMulti(traits, TRAIT_MAP.franchise),
      serial: listing.nft.nftView?.serial ?? 0,
      price: order.salePrice,
      listingResourceID: order.listingResourceID,
    })
  }

  return items
}
