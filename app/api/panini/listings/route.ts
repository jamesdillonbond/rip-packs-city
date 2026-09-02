import { NextResponse } from "next/server"
import { boardRowMeta } from "@/lib/insights/board-meta"

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

interface ListingsPayload {
  listings: ListingOut[]
  floor_eth: number | null
  /** @deprecated Misnamed: the length of the capped page, not the book size.
   *  Kept so existing consumers do not break. Read `returned_rows` + `truncated`. */
  count: number
  returned_rows: number
  /** True when the page filled `LISTINGS_LIMIT` — `count` is then a FLOOR. */
  truncated: boolean
  updated_at: string
}

interface CachedListings {
  data: ListingsPayload
  ts: number
}

// ── In-process cache ──────────────────────────────────────────────────────────

let cache: CachedListings | null = null
const CACHE_TTL = 60 * 1000 // 60 seconds

// How many OpenSea listings one request asks for. Named because the number is
// load-bearing twice over: it is the page cap, and it is therefore also the
// value `truncated` compares against. Changing the URL without changing this
// makes `truncated` read false on exactly the requests that were truncated.
const LISTINGS_LIMIT = 50

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

  // Hoisted out of the try so the catch can tell an UNCONFIGURED key apart from
  // an upstream outage. See the attribution note in the catch below.
  const apiKey = process.env.OPENSEA_API_KEY ?? ""

  try {
    const headers = { "x-api-key": apiKey }

    // Fetch listings
    const listingsRes = await fetch(
      `https://api.opensea.io/api/v2/listings/collection/paniniblockchain/best?limit=${LISTINGS_LIMIT}`,
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

    // ⚠ `count` is the length of a CAPPED page, not the size of the book. The
    // sniper header published it as "N listings", so on any collection with more
    // than LISTINGS_LIMIT live asks the page stated the cap as a census — the
    // row-count failure family documented in lib/insights/board-meta.ts.
    //
    // `floor_eth` is NOT affected and is deliberately still published unhedged:
    // the upstream endpoint is `/best`, which orders by lowest price, so the
    // minimum over the returned page is the collection floor even when the page
    // is truncated. Only the COUNT becomes a floor.
    //
    // The shared helper is used rather than an inline `>= LISTINGS_LIMIT` so the
    // truncation rule stays one decision in one place (it deliberately uses `>=`,
    // not `===`: treating an over-length page as complete is the wrong way to be
    // wrong). Its `total_rows` is remapped onto this route's pre-existing `count`
    // key — the field name here predates the helper and the sniper page reads it.
    const rowMeta = boardRowMeta(listings.length, LISTINGS_LIMIT)
    const result: ListingsPayload = {
      listings,
      floor_eth: minPrice === Infinity ? null : minPrice,
      count: rowMeta.total_rows,
      returned_rows: rowMeta.returned_rows,
      truncated: rowMeta.truncated,
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

    // ⚠ The upstream message is LOGGED, never published. It used to ride out in a
    // `detail` field, which put third-party text (OpenSea's own `401`/rate-limit
    // wording, or a raw Node fetch failure) in front of a user. Same class as the
    // `/api/pack-listings` leak that was publishing Dapper Studio's phrasing — the
    // leaked text is not always ours or Postgres's.
    //
    // NOT routed through `apiErrorResponse` on purpose: that classifier would
    // flatten this to a 500, and the 502 is load-bearing — it says the failure is
    // UPSTREAM, which is what tells an operator whether WE broke.
    // ⚠ A MISSING KEY IS NOT AN UPSTREAM FAILURE — it is ours, and the 502 above
    // says the opposite. OpenSea API v2 rejects an unauthenticated request, so an
    // unset `OPENSEA_API_KEY` 401s every call and lands here, indistinguishable
    // from OpenSea actually being down. Confirmed 2026-09-02: the key is NOT set
    // in Vercel. Nothing could have told us — this logs at `info`, which never
    // reaches Vercel's runtime ERROR groups, and the route is behind the auth
    // wall so it cannot be probed from outside. Name the cause at error level so
    // the misconfiguration surfaces as its own group. Self-extinguishes when the
    // secret is set; the 502 response shape is deliberately unchanged (pinned by
    // __tests__/api-panini-listings-honesty.test.ts).
    if (!apiKey) {
      console.error(
        "[panini/listings] OPENSEA_API_KEY is not set — this 502 is our misconfiguration, not an OpenSea outage"
      )
    }
    console.log(
      "[panini/listings] upstream failure:",
      err instanceof Error ? err.message : String(err)
    )
    return NextResponse.json(
      { error: "Failed to fetch listings", code: "upstream_unavailable", retryable: true },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    )
  }
}
