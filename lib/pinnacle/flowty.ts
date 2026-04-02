import type { PinnacleFlowtyListing } from "./types"

const FLOWTY_ENDPOINT = "https://api.flowty.io/v2/nfts"

const FLOWTY_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  Accept: "application/json",
}

const PINNACLE_COLLECTION = "0xe4cf4bdc1751c65d.Pinnacle"

/**
 * Fetch a page of Pinnacle listings from the Flowty API.
 */
export async function fetchPinnacleFlowtyListings(
  from = 0,
  limit = 24
): Promise<PinnacleFlowtyListing[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null,
        addresses: [],
        collectionFilters: [{ collection: PINNACLE_COLLECTION, traits: [] }],
        from,
        includeAllListings: true,
        limit,
        onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.error(`[pinnacle-flowty] HTTP ${res.status} from=${from}`)
      return []
    }

    const data = await res.json()
    return (Array.isArray(data) ? data : (data.nfts ?? data.listings ?? [])) as PinnacleFlowtyListing[]
  } catch (err) {
    clearTimeout(timeout)
    console.error(
      `[pinnacle-flowty] fetch failed from=${from}: ${err instanceof Error ? err.message : String(err)}`
    )
    return []
  }
}
