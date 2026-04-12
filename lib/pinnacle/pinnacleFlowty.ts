/**
 * lib/pinnacle/pinnacleFlowty.ts
 *
 * Flowty API integration for Disney Pinnacle.
 * Flowty is the SOLE data source for Pinnacle (GQL is Cloudflare-blocked).
 *
 * Endpoint: POST https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle
 * Required header: Origin: https://www.flowty.io
 *
 * Response shape: { address, nfts[], facets[], total }
 * Each NFT has: id, owner, card.title, card.max, card.images[0].url,
 *   nftView.traits.traits (array of {name,value}),
 *   orders[] (active listings), offers[]
 *
 * Listings live in nfts[].orders[] with: salePrice, listingResourceID,
 *   storefrontAddress, state, listingKind, blockTimestamp (ms), nftID,
 *   paymentTokenName, customID, commissionAmount, expiry, transactionId.
 *
 * Flowty has zero FMV for Pinnacle — RPC provides all FMV.
 */

import {
  FLOWTY_PINNACLE_ENDPOINT,
  FLOWTY_PINNACLE_HEADERS,
  PINNACLE_FLOWTY_BUY_URL,
  buildPinnacleEditionKey,
  parseStringifiedArray,
  pinnacleSerialMultiplier,
  isPinnacleSpecialSerial,
  type PinnacleSniperDeal,
} from "./pinnacleTypes"

// ── Flowty Response Types ────────────────────────────────────────────────────

export interface FlowtyPinnacleTrait {
  name: string
  value: string
}

export interface FlowtyPinnacleOrder {
  salePrice: number
  listingResourceID: string
  storefrontAddress: string
  state: string
  listingKind: string
  blockTimestamp: number       // ms
  nftID: string
  paymentTokenName: string
  customID?: string
  commissionAmount?: number
  expiry?: number
  transactionId?: string
}

export interface FlowtyPinnacleNft {
  id: string                   // on-chain NFT ID
  owner: string
  card: {
    title: string              // "Grogu [Lucasfilm Ltd. - Star Wars: The Mandalorian Vol.1, Brushed Silver, Printing #2]"
    max: string | null         // mint count for non-OE, null for OE
    images: Array<{ url: string }>
  }
  nftView: {
    traits: {
      traits: FlowtyPinnacleTrait[]
    }
  }
  orders: FlowtyPinnacleOrder[]
  offers: unknown[]
}

export interface FlowtyPinnacleResponse {
  address: string
  nfts: FlowtyPinnacleNft[]
  facets: unknown[]
  total: number
}

// ── Fetch Flowty Pinnacle NFTs ───────────────────────────────────────────────

/**
 * Fetch Pinnacle NFTs from Flowty with offset/limit pagination.
 * Use listingKind filter to get only listed NFTs.
 */
export async function fetchFlowtyPinnacleListings(options?: {
  limit?: number
  offset?: number
  listedOnly?: boolean
  timeoutMs?: number
}): Promise<FlowtyPinnacleNft[]> {
  const {
    limit = 24,
    offset = 0,
    listedOnly = true,
    timeoutMs = 8000,
  } = options ?? {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const filters: Record<string, unknown> = {}
    if (listedOnly) filters.listingKind = "sale"

    const body = JSON.stringify({ filters, offset, limit })

    const res = await fetch(FLOWTY_PINNACLE_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_PINNACLE_HEADERS,
      body,
      signal: controller.signal,
    })

    if (!res.ok) {
      console.warn(`[pinnacle-flowty] HTTP ${res.status}: ${res.statusText}`)
      return []
    }

    const data: FlowtyPinnacleResponse = await res.json()
    return data.nfts ?? []
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn("[pinnacle-flowty] Fetch timed out after", timeoutMs, "ms")
    } else {
      console.error("[pinnacle-flowty] Fetch error:", err)
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch ALL Pinnacle NFTs in batches using offset pagination.
 * Used by the ingest pipeline to enumerate the full collection.
 */
export async function fetchAllFlowtyPinnacleNfts(options?: {
  batchSize?: number
  maxTotal?: number
  timeoutMs?: number
}): Promise<FlowtyPinnacleNft[]> {
  const {
    batchSize = 24,
    maxTotal = 10000,
    timeoutMs = 10000,
  } = options ?? {}

  const allNfts: FlowtyPinnacleNft[] = []
  let offset = 0

  while (offset < maxTotal) {
    const batch = await fetchFlowtyPinnacleListings({
      limit: batchSize,
      offset,
      listedOnly: false,
      timeoutMs,
    })

    if (batch.length === 0) break
    allNfts.push(...batch)
    offset += batchSize

    // Flowty returns fewer than requested = last page
    if (batch.length < batchSize) break
  }

  return allNfts
}

// ── Trait Extraction Helpers ─────────────────────────────────────────────────

/**
 * Extract a trait map from nftView.traits.traits array.
 */
function getTraitMap(nft: FlowtyPinnacleNft): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of nft.nftView?.traits?.traits ?? []) {
    m.set(t.name, t.value)
  }
  return m
}

/**
 * Extract edition key components from an NFT's traits.
 */
export function extractEditionKeyFromNft(nft: FlowtyPinnacleNft): {
  editionKey: string
  royaltyCode: string
  variant: string
  printing: number
} {
  const traits = getTraitMap(nft)
  const royaltyCodes = parseStringifiedArray(traits.get("RoyaltyCodes"))
  const royaltyCode = royaltyCodes[0] ?? ""
  const variant = traits.get("Variant") ?? "Standard"
  const printing = parseInt(traits.get("Printing") ?? "1", 10)

  return {
    editionKey: buildPinnacleEditionKey(royaltyCode, variant, printing),
    royaltyCode,
    variant,
    printing,
  }
}

// ── Listing -> SniperDeal Mapper ─────────────────────────────────────────────

/**
 * Convert a Flowty NFT with active orders to PinnacleSniperDeals.
 * Each order (listing) on an NFT becomes a separate deal.
 * Requires FMV lookup to calculate discount.
 */
export function flowtyNftToSniperDeals(
  nft: FlowtyPinnacleNft,
  fmvLookup: Map<string, { fmv: number; confidence: string }>
): PinnacleSniperDeal[] {
  const traits = getTraitMap(nft)
  const royaltyCodes = parseStringifiedArray(traits.get("RoyaltyCodes"))
  const royaltyCode = royaltyCodes[0] ?? ""

  if (!royaltyCode) return []

  const variant = traits.get("Variant") ?? "Standard"
  const printing = parseInt(traits.get("Printing") ?? "1", 10)
  const editionKey = buildPinnacleEditionKey(royaltyCode, variant, printing)

  const fmvData = fmvLookup.get(editionKey)
  if (!fmvData || fmvData.fmv <= 0) return []

  const characters = parseStringifiedArray(traits.get("Characters"))
  const franchises = parseStringifiedArray(traits.get("Franchises"))
  const studios = parseStringifiedArray(traits.get("Studios"))
  const editionType = traits.get("EditionType") ?? "Open Edition"
  const isSerialized = editionType === "Limited Edition"
  const mintCount = nft.card.max ? parseInt(nft.card.max, 10) : null
  const seriesYear = parseInt(traits.get("SeriesName") ?? "0", 10) || null

  const activeOrders = (nft.orders ?? []).filter(o => o.state === "LISTED")
  if (activeOrders.length === 0) return []

  const deals: PinnacleSniperDeal[] = []

  for (const order of activeOrders) {
    const askPrice = order.salePrice
    if (!askPrice || askPrice <= 0) continue

    const baseFmv = fmvData.fmv
    const serialMult = pinnacleSerialMultiplier(null, mintCount, isSerialized)
    const adjustedFmv = baseFmv * serialMult
    const discount = Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10

    // Only return deals with meaningful discount
    if (discount < 5) continue

    const { isSpecial, signal } = isPinnacleSpecialSerial(null, mintCount)

    // Normalize blockTimestamp
    const blockTs = order.blockTimestamp
    const ms = blockTs && blockTs > 0
      ? (blockTs < 1e12 ? blockTs * 1000 : blockTs)
      : Date.now()
    const updatedAt = new Date(ms).toISOString()

    deals.push({
      flowId: nft.id,
      nftId: nft.id,
      editionKey,
      characterName: characters[0] ?? "Unknown",
      franchise: franchises[0] ?? "Unknown",
      studio: studios[0] ?? "Unknown",
      setName: traits.get("SetName") ?? "",
      seriesYear,
      variantType: variant,
      editionType: editionType as "Open Edition" | "Limited Edition",
      serial: null,
      mintCount,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount,
      confidence: fmvData.confidence,
      serialMult,
      isSpecialSerial: isSpecial,
      serialSignal: signal,
      thumbnailUrl: nft.card.images?.[0]?.url ?? null,
      isLocked: false,
      updatedAt,
      buyUrl: PINNACLE_FLOWTY_BUY_URL(nft.id, order.listingResourceID),
      listingResourceID: order.listingResourceID ?? null,
      listingOrderID: null,
      storefrontAddress: order.storefrontAddress ?? null,
      source: "flowty",
      offerAmount: null,
      offerFmvPct: null,
    })
  }

  return deals
}
