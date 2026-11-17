import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { installFetchMock, gqlRoute, jsonRoute, makeSupabaseFixture, type InstalledFetchMock } from "./helpers/route-harness"

// Phase 3 of the deep-loop layer: drive pack-ev's fresh EV compute — the real
// TopShot GQL fan-out (PACK_DYNAMIC_QUERY + paginated packEditionsV3) that
// Component B's gqlRoute was built for. The two GraphQL operations + the internal
// pack-listings ask fetch are stubbed via installFetchMock; the RPC-FMV Supabase
// read is stubbed empty so bestPrice falls back to the node's own averageSalePrice.
// This exercises fetchAllEditions pagination, the dual-price resolution, the
// per-edition EV loop (prob * price * 0.95), and the response assembly.

// pack-ev builds its client via createClient() directly, so mock the SDK, not @/lib/supabase.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeSupabaseFixture({}) }))

const { POST } = await import("@/app/api/pack-ev/route")

function editionNode(over: Record<string, any> = {}) {
  return {
    count: 100,
    remaining: 50,
    lastPurchasePrice: 0,
    lowAsk: 0,
    averageSalePrice: 20,
    minSerialNumber: 1,
    maxSerialNumber: 100,
    jerseyNumber: false,
    serialOne: false,
    lastMint: false,
    edition: {
      id: "ed1",
      circulationCount: 100,
      tier: "COMMON",
      marketplaceInfo: { averageSaleData: { averagePrice: "0" } },
      set: { id: "s1", flowName: "Base Set", flowSeriesNumber: 4 },
      play: { id: "p1", headline: "Dunk", stats: { playerName: "Curry", jerseyNumber: 30, teamAtMoment: "GSW", playCategory: "Dunk" } },
      setPlay: { circulations: { burned: 0, circulationCount: 100, forSaleByCollectors: 5, hiddenInPacks: 0, locked: 10, effectiveSupply: 100 } },
      parallelID: null,
      parallelSetPlay: { parallelName: null },
    },
    ...over,
  }
}

function dynamicResp(over: Record<string, any> = {}) {
  return {
    getPackListing: {
      data: {
        id: "pack1",
        forSale: true,
        isSoldOut: false,
        remaining: 50,
        dropType: "STANDARD",
        packListingContentRemaining: {
          unopened: 100,
          totalPackCount: 200,
          remainingByTier: { common: 50, rare: 0, legendary: 0, ultimate: 0, fandom: 0, autograph: 0, anthology: 0 },
          originalCountsByTier: { common: 100, rare: 0, legendary: 0, ultimate: 0, fandom: 0, autograph: 0, anthology: 0 },
        },
        ...over,
      },
    },
  }
}

function editionsResp(nodes: any[], over: Record<string, any> = {}) {
  return {
    getPackListing: {
      data: {
        packEditionsV3: {
          pageInfo: { endCursor: null, hasNextPage: false },
          edges: nodes.map((node) => ({ node })),
          ...over,
        },
      },
    },
  }
}

let harness: InstalledFetchMock | null = null
function post(body: unknown): NextRequest {
  return new NextRequest("https://t/api/pack-ev", { method: "POST", body: JSON.stringify(body) })
}

beforeEach(() => {
  harness?.restore()
  harness = null
})

describe("pack-ev fresh EV compute (GQL fan-out)", () => {
  it("computes EV from the dynamic supply + paginated editions", async () => {
    harness = installFetchMock([
      // topshotFetch returns json.data, so responses are wrapped in the GraphQL envelope.
      gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
      gqlRoute("GetPackEditions", { data: editionsResp([editionNode()]) }),
      jsonRoute("pack-listings", { rows: [] }),
    ])
    const res = await POST(post({ packListingId: "fresh-pack-1", packPrice: 5, collectionId: "nba-top-shot" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    // grossEV = Σ(remaining/unopened * price * 0.95) = 50/100 * 20 * 0.95 = 9.5
    expect(body.grossEV).toBeGreaterThan(0)
    expect(body.editionCount).toBe(1)
    // packEV = grossEV - packPrice; primary listing live at requestedPrice 5.
    expect(body.priceSource).toBe("primary")
  })

  it("502s when the dynamic supply query fails", async () => {
    harness = installFetchMock([
      gqlRoute("GetPackListing_DynamicData", { errors: [{ message: "boom" }] }),
      jsonRoute("pack-listings", { rows: [] }),
    ])
    const res = await POST(post({ packListingId: "fresh-pack-2", collectionId: "nba-top-shot" }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("Failed to fetch pack supply data")
  })

  it("returns bundle_not_supported when the pack has zero editions", async () => {
    harness = installFetchMock([
      gqlRoute("GetPackListing_DynamicData", { data: dynamicResp() }),
      gqlRoute("GetPackEditions", { data: editionsResp([]) }),
      jsonRoute("pack-listings", { rows: [] }),
    ])
    const res = await POST(post({ packListingId: "fresh-pack-3", collectionId: "nba-top-shot" }))
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe("bundle_not_supported")
  })

  it("400s when packListingId is missing (no GQL fetched)", async () => {
    harness = installFetchMock([])
    const res = await POST(post({ collectionId: "nba-top-shot" }))
    expect(res.status).toBe(400)
    expect(harness.calls).toHaveLength(0)
  })
})
