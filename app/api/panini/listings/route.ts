import { NextResponse } from "next/server"

// ── In-process cache ──────────────────────────────────────────────────────────

let cache: { data: Record<string, unknown>; ts: number } | null = null
const CACHE_TTL = 60 * 1000 // 60 seconds

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListingOutput {
  id: string
  name: string
  image_url: string | null
  traits: Record<string, string>
  price_eth: number
  price_usd: number | null
  seller: string
  buy_url: string
  listed_at: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Trait keys to extract — check multiple casings
const TRAIT_KEYS = [
  "Player", "player",
  "Set Name", "set name", "set_name",
  "Serial Number", "serial number", "serial_number",
  "Circulation Count", "circulation count", "circulation_count",
  "Tier", "tier",
  "Sport", "sport",
]

function extractTraits(rawTraits: Array<{ trait_type: string; value: string }> | undefined): Record<string, string> {
  const traits: Record<string, string> = {}
  if (!rawTraits || !Array.isArray(rawTraits)) return traits

  for (const t of rawTraits) {
    // Keep canonical casing for the key
    const matchedKey = TRAIT_KEYS.find(
      (k) => k.toLowerCase() === t.trait_type?.toLowerCase()
    )
    if (matchedKey) {
      traits[matchedKey] = String(t.value)
    }
  }
  return traits
}

async function fetchEthUsd(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return null
    const json = await res.json()
    return json.ethereum?.usd ?? null
  } catch {
    return null
  }
}

// ── GET /api/panini/listings ──────────────────────────────────────────────────

export async function GET() {
  // Return cached data if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  const apiKey = process.env.OPENSEA_API_KEY ?? ""
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    Accept: "application/json",
  }

  try {
    // Fetch listings and ETH price in parallel
    const [listingsRes, ethUsd] = await Promise.all([
      fetch(
        "https://api.opensea.io/api/v2/listings/collection/paniniblockchain/best?limit=50",
        { headers, next: { revalidate: 60 } }
      ),
      fetchEthUsd(),
    ])

    if (!listingsRes.ok) {
      throw new Error(`OpenSea API returned ${listingsRes.status}`)
    }

    const json = await listingsRes.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawListings: any[] = json.listings ?? []

    // Build basic listing data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basicListings = rawListings.map((item: any) => {
      const priceData = item.price?.current
      const decimals = priceData?.decimals ?? 18
      const rawValue = parseFloat(priceData?.value ?? "0")
      const priceEth = rawValue / Math.pow(10, decimals)

      const offer = item.protocol_data?.parameters?.offer?.[0]
      const tokenAddress = offer?.token ?? ""
      const tokenId = offer?.identifierOrCriteria ?? ""
      const seller = item.protocol_data?.parameters?.offerer ?? item.maker?.address ?? ""

      return {
        id: item.order_hash ?? `${tokenAddress}-${tokenId}`,
        tokenAddress,
        tokenId,
        price_eth: priceEth,
        price_usd: ethUsd != null ? priceEth * ethUsd : null,
        seller,
        buy_url: tokenAddress && tokenId
          ? `https://opensea.io/assets/ethereum/${tokenAddress}/${tokenId}`
          : "https://opensea.io/collection/paniniblockchain",
        listed_at: item.listing_time ? new Date(item.listing_time * 1000).toISOString() : null,
        // Placeholders for enrichment
        name: "",
        image_url: null as string | null,
        traits: {} as Record<string, string>,
      }
    })

    // Enrich first 20 listings with NFT metadata
    const enrichLimit = Math.min(20, basicListings.length)
    const enrichPromises = basicListings.slice(0, enrichLimit).map(async (listing) => {
      if (!listing.tokenAddress || !listing.tokenId) return listing
      try {
        const nftRes = await fetch(
          `https://api.opensea.io/api/v2/chain/ethereum/contract/${listing.tokenAddress}/nfts/${listing.tokenId}`,
          { headers }
        )
        if (!nftRes.ok) return listing
        const nftJson = await nftRes.json()
        const nft = nftJson.nft ?? nftJson
        listing.name = nft.name ?? ""
        listing.image_url = nft.image_url ?? null
        listing.traits = extractTraits(nft.traits)
      } catch {
        // Enrichment failed — keep basic data
      }
      return listing
    })

    await Promise.all(enrichPromises)

    // Build final output (strip internal fields)
    const listings: ListingOutput[] = basicListings.map((l) => ({
      id: l.id,
      name: l.name,
      image_url: l.image_url,
      traits: l.traits,
      price_eth: l.price_eth,
      price_usd: l.price_usd,
      seller: l.seller,
      buy_url: l.buy_url,
      listed_at: l.listed_at,
    }))

    // Find floor from sorted listings
    const floor = listings.length > 0
      ? Math.min(...listings.map((l) => l.price_eth))
      : null

    const data = {
      listings,
      floor_eth: floor,
      count: listings.length,
      updated_at: new Date().toISOString(),
    }

    cache = { data, ts: Date.now() }

    return NextResponse.json(data)
  } catch (err) {
    // Return stale cache if available
    if (cache) {
      return NextResponse.json(cache.data)
    }

    return NextResponse.json(
      { error: "Failed to fetch listings", detail: String(err) },
      { status: 502 }
    )
  }
}
