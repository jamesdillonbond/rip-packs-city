/**
 * lib/ufc/ufcFlowty.ts
 *
 * Flowty API integration for UFC Strike.
 * Flowty is the sole data source (no GQL; collection migrated to Aptos July 2025
 * but the Flow contract at 0x329feb3ab062d289.UFC_NFT is still active).
 *
 * Endpoint: POST https://api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT
 * Required header: Origin: https://www.flowty.io
 * Body: {"filters":{},"offset":N,"limit":N}
 *
 * No LiveToken FMV (valuations.blended.usdValue is always 0). Tier must be
 * inferred from circulation count since there is no tier trait.
 */

export const FLOWTY_UFC_ENDPOINT =
  "https://api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT"

export const FLOWTY_UFC_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
} as const

export const UFC_FLOWTY_BUY_URL = (flowId: string, listingResourceID: string) =>
  `https://www.flowty.io/asset/0x329feb3ab062d289/UFC_NFT/NFT/${flowId}?listingResourceID=${listingResourceID}`

export interface FlowtyUfcTrait {
  name?: string
  value?: unknown
}

export interface FlowtyUfcOrder {
  salePrice?: number
  listingResourceID?: string
  storefrontAddress?: string
  state?: string
  blockTimestamp?: number
  nftType?: unknown
}

export interface FlowtyUfcNft {
  id?: string | number
  card?: {
    title?: string
    max?: string | number | null
    num?: string | number | null
    images?: Array<{ url?: string }>
  }
  nftView?: {
    serial?: string | number
    editions?: { infoList?: Array<{ name?: string; number?: number | null; max?: number | null }> }
    traits?: { traits?: FlowtyUfcTrait[] }
  }
  orders?: FlowtyUfcOrder[]
}

export interface FlowtyUfcResponse {
  nfts?: FlowtyUfcNft[]
  total?: number
}

export interface UfcSniperDeal {
  flowId: string
  momentId: string
  editionKey: string
  playerName: string
  tier: string
  serial: number
  circulationCount: number
  askPrice: number
  baseFmv: number
  adjustedFmv: number
  discount: number
  confidence: string
  thumbnailUrl: string | null
  isLocked: boolean
  updatedAt: string
  buyUrl: string
  listingResourceID: string | null
  storefrontAddress: string | null
  source: "flowty"
  paymentToken: "DUC"
}

export async function fetchFlowtyUfcListings(options?: {
  limit?: number
  offset?: number
  timeoutMs?: number
}): Promise<FlowtyUfcNft[]> {
  const { limit = 24, offset = 0, timeoutMs = 10000 } = options ?? {}

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(FLOWTY_UFC_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_UFC_HEADERS,
      body: JSON.stringify({ filters: {}, offset, limit }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(`[ufc-flowty] HTTP ${res.status}`)
      return []
    }
    const data: FlowtyUfcResponse = await res.json()
    return Array.isArray(data.nfts) ? data.nfts : []
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn("[ufc-flowty] fetch timed out after", timeoutMs, "ms")
    } else {
      console.error("[ufc-flowty] fetch error:", err)
    }
    return []
  } finally {
    clearTimeout(timer)
  }
}

export function inferUfcTier(circulation: number | null): string {
  if (circulation === null) return "FANDOM"
  if (circulation <= 10) return "ULTIMATE"
  if (circulation <= 99) return "CHAMPION"
  if (circulation <= 999) return "CHALLENGER"
  if (circulation <= 25000) return "CONTENDER"
  return "FANDOM"
}

export function slugifyUfcEdition(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
}

function traitValue(traits: FlowtyUfcTrait[] | undefined, name: string): string | null {
  if (!traits) return null
  const hit = traits.find((t) => t?.name === name)
  if (!hit || hit.value === null || hit.value === undefined) return null
  return String(hit.value)
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

export function flowtyUfcNftToSniperDeals(
  nft: FlowtyUfcNft,
  fmvLookup: Map<string, { fmv: number; confidence: string }>
): UfcSniperDeal[] {
  const orders = Array.isArray(nft.orders) ? nft.orders : []
  const listedOrders = orders.filter((o) => o?.state === "LISTED")
  if (listedOrders.length === 0) return []

  const flowIdRaw = nft.id ?? nft.card?.num
  if (flowIdRaw === undefined || flowIdRaw === null) return []
  const flowId = String(flowIdRaw)

  const editionInfo = nft.nftView?.editions?.infoList?.[0]
  const editionName = (editionInfo?.name ?? nft.card?.title ?? "").trim()
  if (!editionName) return []

  const circulation =
    toNum(editionInfo?.max) ?? toNum(nft.card?.max) ?? null
  const serial = toNum(editionInfo?.number) ?? 0
  const editionKey = slugifyUfcEdition(editionName, circulation)
  const tier = inferUfcTier(circulation)

  const traits = nft.nftView?.traits?.traits
  const fighterName = traitValue(traits, "ATHLETE 1") ?? "Unknown"

  const thumbnail = nft.card?.images?.[0]?.url ?? null
  const fmvData = fmvLookup.get(editionKey)

  const deals: UfcSniperDeal[] = []
  for (const order of listedOrders) {
    const askPrice = toNum(order.salePrice)
    if (!askPrice || askPrice <= 0) continue

    const listingResourceID = order.listingResourceID ?? null
    if (!listingResourceID) continue

    const baseFmv = fmvData?.fmv ?? askPrice
    const adjustedFmv = baseFmv
    const discount = adjustedFmv > 0
      ? Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10
      : 0
    const confidence = (fmvData?.confidence ?? "ASK_ONLY").toLowerCase()

    const blockTs = order.blockTimestamp
    const ms = blockTs && blockTs > 0
      ? (blockTs < 1e12 ? blockTs * 1000 : blockTs)
      : Date.now()
    const updatedAt = new Date(ms).toISOString()

    deals.push({
      flowId,
      momentId: flowId,
      editionKey,
      playerName: fighterName,
      tier,
      serial,
      circulationCount: circulation ?? 0,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount,
      confidence,
      thumbnailUrl: thumbnail,
      isLocked: false,
      updatedAt,
      buyUrl: UFC_FLOWTY_BUY_URL(flowId, listingResourceID),
      listingResourceID,
      storefrontAddress: order.storefrontAddress ?? null,
      source: "flowty",
      paymentToken: "DUC",
    })
  }

  return deals
}
