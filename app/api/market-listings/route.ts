// app/api/market-listings/route.ts
//
// Fetches live Flowty listings for a specific edition (setID:playID format).
// Used by the Market page listings modal when a user clicks SELECT.
//
// GET /api/market-listings?edition=123:456
//
// Returns: { listings: [ { listingResourceID, storefrontAddress, salePrice, serial } ] }
// Sorted by price ascending.

import { NextRequest, NextResponse } from "next/server"

const FLOWTY_API = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot"
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "RipPacksCity/1.0",
}
const FLOWTY_TIMEOUT_MS = 10_000

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const editionKey = req.nextUrl.searchParams.get("edition") ?? ""
  if (!editionKey) {
    return NextResponse.json({ error: "edition param required" }, { status: 400 })
  }

  // Parse setID:playID
  const parts = editionKey.split(":")
  if (parts.length < 2) {
    return NextResponse.json({ error: "invalid edition format, expected setID:playID" }, { status: 400 })
  }
  const [setId, playId] = parts

  try {
    // Flowty's collection endpoint filters by setID + playID via query params
    // We fetch with a generous limit and sort by price
    const body = JSON.stringify({
      from: 0,
      size: 100,
      filters: {
        "nft.setID": setId,
        "nft.playID": playId,
      },
      sort: [{ "salePrice": "asc" }],
    })

    const res = await fetch(FLOWTY_API, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body,
      signal: AbortSignal.timeout(FLOWTY_TIMEOUT_MS),
    })

    if (!res.ok) {
      console.error(`[market-listings] Flowty HTTP ${res.status}`)
      return NextResponse.json({ listings: [], error: `Flowty HTTP ${res.status}` })
    }

    const json = await res.json()
    const rawItems: any[] = json.nfts ?? json.data ?? []

    const listings: {
      listingResourceID: string
      storefrontAddress: string
      salePrice: number
      serial: number
    }[] = []

    for (const item of rawItems) {
      const orders: any[] = item.orders ?? []
      const activeOrder = orders.find((o: any) =>
        o.state === "ACTIVE" || !o.state
      )
      if (!activeOrder) continue

      const salePrice = parseFloat(activeOrder.salePrice ?? "0")
      if (!salePrice || salePrice <= 0) continue

      const serial =
        item.nftView?.serial ??
        item.card?.num ??
        parseInt(
          (item.nftView?.traits ?? []).find((t: any) => t.name === "serialNumber")?.value ?? "0",
          10
        ) ?? 0

      listings.push({
        listingResourceID: activeOrder.listingResourceID ?? activeOrder.id ?? "",
        storefrontAddress: (activeOrder.storefrontAddress ?? activeOrder.flowtyStorefrontAddress ?? "").replace(/^0x/, "0x"),
        salePrice,
        serial: Number(serial),
      })
    }

    // Sort by price ascending (Flowty should already do this, but enforce it)
    listings.sort((a, b) => a.salePrice - b.salePrice)

    return NextResponse.json(
      { listings },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } }
    )
  } catch (err: any) {
    console.error("[market-listings]", err)
    return NextResponse.json(
      { listings: [], error: err?.message ?? "Unknown error" },
      { status: 200 } // Return 200 with empty so modal shows "no listings" not error
    )
  }
}
