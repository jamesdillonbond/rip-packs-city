import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// allday-pack-ev, node-shaping coverage. The sibling api-allday-pack-ev.test.ts
// drives the guard + one fixed node; this file makes the edition node MUTABLE so
// each test exercises a different arm of bestPrice() (the price-source ladder),
// serialPremiumLabel() (#1 / last-mint / jersey), and normalizeTier() (the
// tierBreakdown keys) — all of which were previously dark. Everything routes
// through the real POST handler; only the injected node varies.

const nodeState = vi.hoisted(() => ({ node: null as any }))

function baseNode(overrides: Record<string, any> = {}) {
  return {
    count: 10, remaining: 5, lastPurchasePrice: 0, lowAsk: 0, averageSalePrice: 0,
    minSerialNumber: 1, maxSerialNumber: 10, jerseyNumber: false, serialOne: false, lastMint: false,
    edition: {
      id: "ed1", circulationCount: 10, tier: "MOMENT_TIER_COMMON",
      marketplaceInfo: { averageSaleData: { averagePrice: "0" } },
      set: { id: "s1", flowName: "Set One", flowSeriesNumber: 1 },
      play: { id: "p1", headline: "h", stats: { playerName: "Player One", jerseyNumber: "7", teamAtMoment: "Team", playCategory: "Cat" } },
      setPlay: { circulations: { burned: 0, circulationCount: 10, forSaleByCollectors: 0, hiddenInPacks: 0, locked: 0, effectiveSupply: 10 } },
      parallelID: 0, parallelSetPlay: { parallelName: "" },
    },
    ...overrides,
  }
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const b: any = {
        select: () => b, in: () => b, eq: () => b, order: () => b, upsert: () => b, insert: () => b,
        then: (resolve: any) => resolve({ data: null, error: null }),
      }
      return b
    },
  }),
}))

vi.mock("@/lib/chains/flow/allday", () => ({
  alldayGraphql: async (query: string) => {
    if (query.includes("packEditionsV3")) {
      return {
        getPackListing: {
          data: {
            packEditionsV3: {
              pageInfo: { endCursor: null, hasNextPage: false },
              edges: [{ node: nodeState.node }],
            },
          },
        },
      }
    }
    return {
      getPackListing: {
        data: {
          id: "pack1", forSale: true, isSoldOut: false, remaining: 5, dropType: "STANDARD",
          packListingContentRemaining: { unopened: 100, totalPackCount: 200, remainingByTier: {}, originalCountsByTier: {} },
        },
      },
    }
  },
}))

const { POST } = await import("@/app/api/allday-pack-ev/route")

function req(body: any): NextRequest {
  return new NextRequest("https://t/api/allday-pack-ev", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}
// The route caches EV results by packListingId, so every run needs a UNIQUE id
// or a later test silently reads the first test's cached node.
let packSeq = 0
async function run(overrides: Record<string, any> = {}) {
  nodeState.node = baseNode(overrides)
  const res = await POST(req({ packListingId: `pack-node-${++packSeq}`, packPrice: 5 }))
  return { res, body: await res.json() }
}

beforeEach(() => { nodeState.node = baseNode() })

describe("allday-pack-ev — bestPrice price-source ladder", () => {
  it("uses pack_wap when averageSalePrice > 0", async () => {
    const { body } = await run({ averageSalePrice: 20 })
    expect(body.topPulls[0].priceSource).toBe("pack_wap")
    expect(body.grossEV).toBeCloseTo(0.95, 2) // 0.05 * 20 * 0.95
  })

  it("falls to market_wap (marketplace averagePrice) when pack WAP is 0", async () => {
    const { body } = await run({
      averageSalePrice: 0,
      edition: { ...baseNode().edition, marketplaceInfo: { averageSaleData: { averagePrice: "15" } } },
    })
    expect(body.topPulls[0].priceSource).toBe("market_wap")
    expect(body.grossEV).toBeCloseTo(0.71, 2) // 0.05 * 15 * 0.95, rounded to 2dp
  })

  it("falls to ask (lowAsk * 0.95) when no WAP is available", async () => {
    const { body } = await run({ averageSalePrice: 0, lowAsk: 10 })
    expect(body.topPulls[0].priceSource).toBe("ask")
    expect(body.grossEV).toBeCloseTo(0.451, 2) // 0.05 * (10*0.95) * 0.95
  })

  it("falls to last_sale (lastPurchasePrice * 0.80) as the final priced arm", async () => {
    const { body } = await run({ averageSalePrice: 0, lowAsk: 0, lastPurchasePrice: 100 })
    expect(body.topPulls[0].priceSource).toBe("last_sale")
    expect(body.grossEV).toBeCloseTo(3.8, 2) // 0.05 * (100*0.80) * 0.95
  })

  it("reports priceSource 'none' and zero EV when nothing is priced", async () => {
    const { body } = await run({ averageSalePrice: 0, lowAsk: 0, lastPurchasePrice: 0 })
    expect(body.topPulls[0].priceSource).toBe("none")
    expect(body.grossEV).toBeCloseTo(0, 5)
  })
})

describe("allday-pack-ev — serialPremiumLabel", () => {
  it("labels a #1 serial", async () => {
    const { body } = await run({ averageSalePrice: 20, serialOne: true })
    expect(body.topPulls[0].serialPremiumLabel).toContain("#1 Serial")
    expect(body.serialPremiumAlerts.length).toBeGreaterThan(0)
  })

  it("combines last-mint and jersey-match labels", async () => {
    const { body } = await run({ averageSalePrice: 20, lastMint: true, jerseyNumber: true })
    expect(body.topPulls[0].serialPremiumLabel).toContain("Last Mint")
    expect(body.topPulls[0].serialPremiumLabel).toContain("Jersey #7 Match")
  })

  it("has a null premium label for an ordinary serial", async () => {
    const { body } = await run({ averageSalePrice: 20 })
    expect(body.topPulls[0].serialPremiumLabel).toBeNull()
  })
})

describe("allday-pack-ev — tier normalization / breakdown", () => {
  it("keys the tier breakdown by the normalized LEGENDARY tier", async () => {
    const { body } = await run({
      averageSalePrice: 20,
      edition: { ...baseNode().edition, tier: "MOMENT_TIER_LEGENDARY" },
    })
    expect(Object.keys(body.tierBreakdown)).toContain("legendary")
  })

  it("keys the tier breakdown by the normalized RARE tier", async () => {
    const { body } = await run({
      averageSalePrice: 20,
      edition: { ...baseNode().edition, tier: "MOMENT_TIER_RARE" },
    })
    expect(Object.keys(body.tierBreakdown)).toContain("rare")
  })
})
