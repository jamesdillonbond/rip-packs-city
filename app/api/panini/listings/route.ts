import { NextResponse } from "next/server"

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListingOut {
  id: string
  name: string | null
  image_url: string | null
  traits: Record<string, string>
  price_eth: number
  price_usd: number | null
  seller: string
  listed_at: string
  buy_url: string
}

interface CachedListings {
  data: { listings: ListingOut[]; floor_eth: number | null; count: number; updated_at: string }
  ts: number
}

// ── In-process cache ──────────────────────────────────────────────────────────

let cache: CachedListings | null = null
const CACHE_TTL = 60 * 1000 // 60 seconds

// ── Trait key normalization ───────────────────────────────────────────────────

const TRAIT_KEYS = ["Player", "Set Name", "Serial Number", "Circulation Count", "Tier", "Sport"]

function normalizeTrait(key: string): string | null {
  const lower = key.toLowerCase()
  for (const tk of TRAIT_KEYS) {
    if (tk.toLowerCase() === lower) return tk
  }
  return null
}

// ── GET /api/panini/listings ──────────────────────────────────────────────────

export async function GET() {
  const now = Date.now()

  // Return cached if fresh
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data, {
      headers: { "Cache-Control": "public, max-age=60" },
    })
  }

  try {
    const apiKey = process.env.OPENSEA_API_KEY ?? ""
    const headers = { "x-api-key": apiKey }

    // Fetch listings
    const listingsRes = await fetch(
      "https://api.opensea.io/api/v2/listings/collection/paniniblockchain/best?limit=50",
      { headers }
    )

    if (!listingsRes.ok) {
      throw new Error(`OpenSea listings API ${listingsRes.status}`)
    }

    const listingsJson = await listingsRes.json()
    const orders = listingsJson.listings ?? listingsJson.orders ?? []

    // Fetch ETH/USD price
    let ethUsd: number | null = null
    try {
      const cgRes = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
        { next: { revalidate: 300 } }
      )
      if (cgRes.ok) {
        const cgData = await cgRes.json()
        ethUsd = cgData?.ethereum?.usd ?? null
      }
    } catch {
      // Non-critical — USD conversion just won't be available
    }

    // Process each listing
    const listings: ListingOut[] = []
    let minPrice = Infinity

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i]
      const orderId = order.order_hash ?? order.id ?? `order-${i}`

      // Extract price
      const priceData = order.price?.current
      let priceEth = 0
      if (priceData) {
        const value = parseFloat(priceData.value ?? "0")
        const decimals = priceData.decimals ?? 18
        priceEth = value / Math.pow(10, decimals)
      }

      if (priceEth > 0 && priceEth < minPrice) {
        minPrice = priceEth
      }

      // Extract seller
      const seller = order.maker?.address ?? order.protocol_data?.parameters?.offerer ?? ""

      // Extract token info from offer
      const offer = order.protocol_data?.parameters?.offer?.[0]
      const tokenAddress = offer?.token ?? ""
      const tokenId = offer?.identifierOrCriteria ?? ""

      const buyUrl = tokenAddress && tokenId
        ? `https://opensea.io/assets/ethereum/${tokenAddress}/${tokenId}`
        : "https://opensea.io/collection/paniniblockchain"

      // Listed time
      const listedAt = order.listing_time
        ? new Date(Number(order.listing_time) * 1000).toISOString()
        : order.created_date ?? new Date().toISOString()

      // Enrich first 20 listings with NFT metadata
      let name: string | null = null
      let imageUrl: string | null = null
      const traits: Record<string, string> = {}

      if (i < 20 && tokenAddress && tokenId) {
        try {
          const nftRes = await fetch(
            `https://api.opensea.io/api/v2/chain/ethereum/contract/${tokenAddress}/nfts/${tokenId}`,
            { headers }
          )
          if (nftRes.ok) {
            const nftData = await nftRes.json()
            const nft = nftData.nft ?? nftData
            name = nft.name ?? null
            imageUrl = nft.image_url ?? null

            // Extract traits
            const traitArr = nft.traits ?? []
            for (const t of traitArr) {
              const traitType = t.trait_type ?? t.type ?? ""
              const traitValue = String(t.value ?? "")
              const normalized = normalizeTrait(traitType)
              if (normalized) {
                traits[normalized] = traitValue
              }
            }
          }
        } catch {
          // Non-critical — listing will just lack metadata
        }
      }

      listings.push({
        id: orderId,
        name,
        image_url: imageUrl,
        traits,
        price_eth: priceEth,
        price_usd: ethUsd != null ? priceEth * ethUsd : null,
        seller,
        listed_at: listedAt,
        buy_url: buyUrl,
      })
    }

    const result = {
      listings,
      floor_eth: minPrice === Infinity ? null : minPrice,
      count: listings.length,
      updated_at: new Date().toISOString(),
    }

    cache = { data: result, ts: now }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=60" },
    })
  } catch (err) {
    // Return stale cache if available
    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { "Cache-Control": "public, max-age=30" },
      })
    }

    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json(
      { error: "Failed to fetch listings", detail: message },
      { status: 502 }
    )
  }
}
