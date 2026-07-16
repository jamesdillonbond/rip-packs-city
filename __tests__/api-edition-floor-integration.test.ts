import { describe, it, expect, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, jsonRoute, type InstalledFetchMock } from "./helpers/route-harness"

// PROOF-OF-CONCEPT: route-integration test driving the ACTUAL handler body, not
// just its guards. GET/POST /api/edition-floor (non-persist) resolve each edition
// through two live fetches — Top Shot GQL + Flowty — and no Supabase, so the
// harness stubs exactly those two seams and we assert the real cross-market
// merge the handler produces. This exercises fetchTopShotFloor, fetchFlowtyFloor,
// resolveEditionFloor, selectCrossMarketFloor, and the GET/POST orchestration —
// the ~18%->happy-path body the guard-only test never reached.
//
// This is the template the other flagship routes (sniper-feed, pack-ev, ...)
// can follow: declare fetch fixtures, call the handler, assert the response.

import { GET, POST } from "@/app/api/edition-floor/route"

// Top Shot searchEditions response carrying one edition's lowestAsk + forSaleCount.
function tsFloor(lowestAsk: number | null, forSaleCount: number) {
  return {
    data: {
      searchEditions: {
        data: {
          searchSummary: {
            data: { data: [{ setID: "1", playID: "2", lowestAsk, forSaleCount, circulationCount: 100 }] },
          },
        },
      },
    },
  }
}

// Flowty listings response — LISTED orders become candidate prices; floor = min.
function flowtyListings(prices: number[], livetoken?: number) {
  return {
    nfts: prices.map((salePrice, i) => ({
      id: `nft-${i}`,
      orders: [{ salePrice, state: "LISTED", nftID: `n${i}` }],
      valuations: i === 0 && livetoken ? { livetoken: { usdValue: livetoken } } : undefined,
    })),
  }
}

let harness: InstalledFetchMock | null = null
afterEach(() => {
  harness?.restore()
  harness = null
})

describe("GET /api/edition-floor — integration (real handler, stubbed venues)", () => {
  it("400s without an editionKey (no fetch made)", async () => {
    harness = installFetchMock([])
    const res = await GET(new NextRequest("https://t/api/edition-floor"))
    expect(res.status).toBe(400)
    expect(harness.calls).toHaveLength(0)
  })

  it("merges Top Shot + Flowty floors and picks the lower as cross-market", async () => {
    harness = installFetchMock([
      jsonRoute("nbatopshot.com", tsFloor(12.5, 3)),
      jsonRoute("flowty.io", flowtyListings([20, 15], 18)),
    ])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.topShotFloor).toBe(12.5)
    expect(body.topShotListingCount).toBe(3)
    expect(body.flowtyFloor).toBe(15) // min(20,15)
    expect(body.flowtyListingCount).toBe(2)
    expect(body.crossMarketFloor).toBe(12.5) // TS is lower
    expect(body.crossMarketSource).toBe("topshot")
    expect(body.livetokenFmv).toBe(18)
    // exactly the two venue calls were made
    expect(harness.calls).toHaveLength(2)
  })

  it("falls back to Flowty as the cross-market source when Top Shot has no ask", async () => {
    harness = installFetchMock([
      jsonRoute("nbatopshot.com", tsFloor(null, 0)),
      jsonRoute("flowty.io", flowtyListings([9])),
    ])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    const body = await res.json()
    expect(body.topShotFloor).toBeNull()
    expect(body.crossMarketFloor).toBe(9)
    expect(body.crossMarketSource).toBe("flowty")
  })

  it("reports null floors when a venue endpoint errors (best-effort, still 200)", async () => {
    harness = installFetchMock([
      jsonRoute("nbatopshot.com", {}, { status: 502 }),
      jsonRoute("flowty.io", {}, { status: 500 }),
    ])
    const res = await GET(new NextRequest("https://t/api/edition-floor?editionKey=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.crossMarketFloor).toBeNull()
    expect(body.crossMarketSource).toBeNull()
  })
})

describe("POST /api/edition-floor — integration (batch, non-persist)", () => {
  it("resolves each editionKey and returns a results array", async () => {
    harness = installFetchMock([
      jsonRoute("nbatopshot.com", tsFloor(5, 1)),
      jsonRoute("flowty.io", flowtyListings([7])),
    ])
    const res = await POST(
      new NextRequest("https://t/api/edition-floor", {
        method: "POST",
        body: JSON.stringify({ editionKeys: ["1:2"] }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].crossMarketFloor).toBe(5) // min(5,7) -> TS
  })

  it("returns an empty results array for an empty editionKeys list (no fetch)", async () => {
    harness = installFetchMock([])
    const res = await POST(
      new NextRequest("https://t/api/edition-floor", { method: "POST", body: JSON.stringify({ editionKeys: [] }) }),
    )
    expect((await res.json()).results).toEqual([])
    expect(harness.calls).toHaveLength(0)
  })
})
