import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/allday-pack-ev.
// The first guard requires a packListingId in the body (400 otherwise) before
// any AllDay GQL fan-out. For the success path we mock @/lib/allday so the
// dynamic-data query returns a stocked pack (unopened > 0) and the editions
// query returns one edition, and @supabase/supabase-js so the RPC-FMV lookup +
// fire-and-forget seed writes are inert — driving the full EV computation to a
// 200 with a computed grossEV.

// Chainable, thenable Supabase stub: reads resolve { data: null } (so the RPC
// FMV lookup finds nothing and falls back to All Day marketplace prices);
// upsert/insert are inert thenables so the fire-and-forget seed writes no-op.
vi.mock("@supabase/supabase-js", () => {
  const sbChain: any = {
    select: () => sbChain,
    in: () => sbChain,
    eq: () => sbChain,
    order: () => sbChain,
    upsert: () => sbChain,
    insert: () => sbChain,
    then: (resolve: any) => resolve({ data: null, error: null }),
  }
  return { createClient: () => ({ from: () => sbChain }) }
})

vi.mock("@/lib/allday", () => ({
  alldayGraphql: async (query: string) => {
    // The editions page (PACK_EDITIONS_QUERY) selects packEditionsV3.
    if (query.includes("packEditionsV3")) {
      return {
        getPackListing: {
          data: {
            packEditionsV3: {
              pageInfo: { endCursor: null, hasNextPage: false },
              edges: [
                {
                  node: {
                    count: 10,
                    remaining: 5,
                    lastPurchasePrice: 0,
                    lowAsk: 0,
                    averageSalePrice: 20,
                    minSerialNumber: 1,
                    maxSerialNumber: 10,
                    jerseyNumber: false,
                    serialOne: false,
                    lastMint: false,
                    edition: {
                      id: "ed1",
                      circulationCount: 10,
                      tier: "MOMENT_TIER_COMMON",
                      marketplaceInfo: { averageSaleData: { averagePrice: "0" } },
                      set: { id: "s1", flowName: "Set One", flowSeriesNumber: 1 },
                      play: {
                        id: "p1",
                        headline: "h",
                        stats: {
                          playerName: "Player One",
                          jerseyNumber: "0",
                          teamAtMoment: "Team",
                          playCategory: "Cat",
                        },
                      },
                      setPlay: {
                        circulations: {
                          burned: 0,
                          circulationCount: 10,
                          forSaleByCollectors: 0,
                          hiddenInPacks: 0,
                          locked: 0,
                          effectiveSupply: 10,
                        },
                      },
                      parallelID: 0,
                      parallelSetPlay: { parallelName: "" },
                    },
                  },
                },
              ],
            },
          },
        },
      }
    }
    // The dynamic-data query (PACK_DYNAMIC_QUERY) — a stocked, for-sale pack.
    return {
      getPackListing: {
        data: {
          id: "pack1",
          forSale: true,
          isSoldOut: false,
          remaining: 5,
          dropType: "STANDARD",
          packListingContentRemaining: {
            unopened: 100,
            totalPackCount: 200,
            remainingByTier: {},
            originalCountsByTier: {},
          },
        },
      },
    }
  },
}))

import { POST } from "@/app/api/allday-pack-ev/route"

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-pack-ev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/allday-pack-ev — param guard", () => {
  it("400s when packListingId is missing", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("packListingId is required")
  })

  it("400s when packListingId is an empty string", async () => {
    expect((await POST(req({ packListingId: "" }))).status).toBe(400)
  })
})

describe("POST /api/allday-pack-ev — success path", () => {
  it("200s with a computed grossEV for a stocked pack", async () => {
    const res = await POST(req({ packListingId: "pack1", packPrice: 5 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.packListingId).toBe("pack1")
    expect(body.editionCount).toBe(1)
    // one edition: prob = 5/100 = 0.05, price = 20 (pack_wap), ev = 0.05*20*0.95
    expect(body.grossEV).toBeCloseTo(0.95, 2)
    expect(typeof body.packEV).toBe("number")
    expect(Array.isArray(body.topPulls)).toBe(true)
    expect(body.cached).toBe(false)
  })
})
