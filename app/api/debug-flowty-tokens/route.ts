import { NextResponse } from "next/server"

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot"
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
}

async function fetchPage(paymentTokens: string[], from: number) {
  const res = await fetch(FLOWTY_ENDPOINT, {
    method: "POST",
    headers: FLOWTY_HEADERS,
    body: JSON.stringify({
      address: null, addresses: [],
      collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
      from, includeAllListings: true, limit: 100, onlyUnlisted: false,
      orderFilters: [{ conditions: [], kind: "storefront", paymentTokens }],
      sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
    }),
  })
  if (!res.ok) throw new Error(`Flowty ${res.status}`)
  return res.json()
}

export async function GET() {
  // Fetch 3 pages with no filter (300 listings) to get full breakdown
  const pages = await Promise.all([
    fetchPage([], 0),
    fetchPage([], 24),
    fetchPage([], 48),
  ])

  const tokenCounts: Record<string, number> = {}
  const tokenSamples: Record<string, { player: string; price: number; listingResourceID: string }[]> = {}
  let total = 0

  for (const page of pages) {
    for (const nft of page.nfts ?? []) {
      for (const order of nft.orders ?? []) {
        if (order.state !== "LISTED") continue
        const token = order.paymentTokenName ?? "unknown"
        tokenCounts[token] = (tokenCounts[token] ?? 0) + 1
        total++
        // Keep up to 3 samples per token
        if (!tokenSamples[token]) tokenSamples[token] = []
        if (tokenSamples[token].length < 3) {
          tokenSamples[token].push({
            player: nft.card?.title ?? "?",
            price: order.salePrice,
            listingResourceID: order.listingResourceID,
          })
        }
      }
    }
  }

  // Calculate percentages
  const breakdown = Object.entries(tokenCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([token, count]) => ({
      token,
      count,
      pct: `${((count / total) * 100).toFixed(1)}%`,
      samples: tokenSamples[token],
    }))

  return NextResponse.json({ total, breakdown })
}