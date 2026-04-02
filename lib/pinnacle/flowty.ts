// Fetch Disney Pinnacle listings from Flowty API
// API response shape: { address, nfts: [...], facets, total }

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xeaf1c73b68f0de8d/Pinnacle"

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

export interface FlowtyOrder {
  listingResourceID: string
  storefrontAddress: string
  flowtyStorefrontAddress?: string
  salePrice: number
  blockTimestamp: number
  state?: string
  salePaymentVaultType?: string
}

export interface FlowtyNftItem {
  id: string
  orders?: FlowtyOrder[]
  card?: { title?: string; num?: number; max?: number }
  nftView?: {
    serial?: number
    traits?: {
      traits: Array<{ name: string; value: string }>
    }
  }
  valuations?: {
    blended?: { usdValue?: number }
    livetoken?: { usdValue?: number }
  }
}

/**
 * Fetch a single page of Pinnacle listings from Flowty.
 * The API returns { address, nfts: [...], facets, total }.
 * We extract data.nfts so callers get the NFT array, not the whole response.
 */
export async function fetchPinnacleListings(
  from: number = 0,
  limit: number = 24
): Promise<FlowtyNftItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null,
        addresses: [],
        collectionFilters: [
          { collection: "0xeaf1c73b68f0de8d.Pinnacle", traits: [] },
        ],
        from,
        includeAllListings: true,
        limit,
        onlyUnlisted: false,
        orderFilters: [
          { conditions: [], kind: "storefront", paymentTokens: [] },
        ],
        sort: {
          direction: "desc",
          listingKind: "storefront",
          path: "blockTimestamp",
        },
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error(
        `[pinnacle-flowty] HTTP ${res.status} from=${from}`
      )
      return []
    }

    const data = await res.json()

    // The API returns { address, nfts: [...], facets, total }
    // Extract the nfts array — do NOT return the whole response object
    return data.nfts ?? []
  } catch (err) {
    clearTimeout(timeout)
    console.error(
      `[pinnacle-flowty] from=${from} FAILED: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}

/**
 * Fetch multiple pages of Pinnacle listings from Flowty.
 */
export async function fetchAllPinnacleListings(): Promise<FlowtyNftItem[]> {
  const pages = await Promise.all([
    fetchPinnacleListings(0),
    fetchPinnacleListings(24),
    fetchPinnacleListings(48),
    fetchPinnacleListings(72),
  ])
  return pages.flat()
}
