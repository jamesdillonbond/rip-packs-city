// Sync Disney Pinnacle Flowty listings into a normalized format
// Trait path: listing.nftView.traits.traits (nftView is directly on the listing)

import {
  fetchAllPinnacleListings,
  type FlowtyNftItem,
} from "./flowty"

// Vault type → short payment token mapping
const VAULT_TO_PAYMENT_TOKEN: Record<string, "DUC" | "FUT" | "FLOW" | "USDC_E"> = {
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault": "DUC",
  "A.609e10301860b683.FlowUtilityToken.Vault": "FUT",
  "A.7e60df042a9c0868.FlowToken.Vault": "FLOW",
  "A.f1ab99c82dee3526.USDCFlow.Vault": "USDC_E",
}

// Multi-key trait lookup
const TRAIT_MAP: Record<string, string[]> = {
  pinName:    ["PinName", "pinName", "Pin Name", "name"],
  rarity:     ["Rarity", "rarity", "Tier", "tier"],
  series:     ["Series", "series", "SeriesName", "seriesName"],
  variant:    ["Variant", "variant"],
  brand:      ["Brand", "brand", "Franchise", "franchise"],
  edition:    ["Edition", "edition", "EditionSize", "editionSize"],
}

export interface PinnacleListing {
  nftId: string
  listingResourceID: string
  storefrontAddress: string
  price: number
  livetokenFmv: number | null
  blockTimestamp: number
  pinName: string
  serial: number
  circulationCount: number
  rarity: string
  series: string
  variant: string
  brand: string
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E"
}

function getTraitMulti(
  traits: Array<{ name: string; value: string }> | undefined,
  keys: string[]
): string {
  if (!traits) return ""
  for (const key of keys) {
    const found = traits.find((t) => t.name === key)
    if (found?.value) return found.value
  }
  return ""
}

/**
 * Transform a raw Flowty NFT item into a PinnacleListing.
 *
 * Trait access: listing.nftView.traits.traits
 * (nftView is directly on the listing, NOT listing.nft.nftView)
 */
function transformListing(listing: FlowtyNftItem): PinnacleListing | null {
  const order =
    listing.orders?.find((o) => (o.salePrice ?? 0) > 0) ??
    listing.orders?.[0]

  if (!order?.listingResourceID || order.salePrice <= 0) return null

  // Correct path: listing.nftView.traits.traits
  // The Flowty response nests traits inside nftView.traits.traits
  const traits = listing.nftView?.traits?.traits ?? []
  const serial = listing.card?.num ?? listing.nftView?.serial ?? 0
  const circ = listing.card?.max ?? 0
  const livetokenFmv =
    listing.valuations?.blended?.usdValue ??
    listing.valuations?.livetoken?.usdValue ??
    null

  const paymentToken =
    VAULT_TO_PAYMENT_TOKEN[order.salePaymentVaultType ?? ""] ?? "DUC"

  return {
    nftId: String(listing.id),
    listingResourceID: order.listingResourceID,
    storefrontAddress:
      order.storefrontAddress ?? order.flowtyStorefrontAddress ?? "",
    price: order.salePrice,
    livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
    blockTimestamp: order.blockTimestamp ?? 0,
    pinName:
      listing.card?.title ??
      getTraitMulti(traits, TRAIT_MAP.pinName) ??
      "",
    serial,
    circulationCount: circ,
    rarity: (
      getTraitMulti(traits, TRAIT_MAP.rarity) || "COMMON"
    ).toUpperCase(),
    series: getTraitMulti(traits, TRAIT_MAP.series),
    variant: getTraitMulti(traits, TRAIT_MAP.variant),
    brand: getTraitMulti(traits, TRAIT_MAP.brand),
    paymentToken,
  }
}

/**
 * Fetch and transform all Pinnacle Flowty listings.
 */
export async function syncPinnacleListings(): Promise<PinnacleListing[]> {
  const rawItems = await fetchAllPinnacleListings()

  if (rawItems.length > 0) {
    // Log trait keys from first item for debugging
    const firstTraits = rawItems[0].nftView?.traits?.traits ?? []
    console.log(
      `[pinnacle-sync] trait keys: ${firstTraits.map((t) => t.name).join(", ")}`
    )
  }

  console.log(`[pinnacle-sync] raw items: ${rawItems.length}`)

  const listings: PinnacleListing[] = []
  for (const item of rawItems) {
    const listing = transformListing(item)
    if (listing) listings.push(listing)
  }

  console.log(`[pinnacle-sync] transformed listings: ${listings.length}`)
  return listings
}
