import { describe, it, expect, beforeEach, vi } from "vitest"

// Route-integration test for GET /api/sniper-feed's handler ORCHESTRATION —
// applyOuterFilters (editionKey / player / flowWalletOnly), the limit slice, and
// the response shaping + marketplaceAvailability. The 400-line Top Shot compute
// (live GQL fan-out) is bypassed by stubbing getOrSetCache to return a controlled
// FeedResult, so this pins the handler logic that sits on top of the compute
// without needing to mock the whole pool pipeline. (The compute internals'
// pure helpers are separately unit-tested in sniper-feed-helpers.test.ts.)

const cache = vi.hoisted(() => ({ result: null as any }))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) =>
    cache.result ?? factory(),
}))

import { GET } from "@/app/api/sniper-feed/route"

function deal(over: Record<string, any>) {
  return {
    editionKey: "",
    intEditionKey: "",
    playerName: "",
    paymentToken: "DUC",
    flowId: "f",
    ...over,
  }
}

function feed(deals: any[]) {
  return { count: deals.length, tsCount: deals.length, flowtyCount: 0, lastRefreshed: "t", deals }
}

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)

beforeEach(() => {
  cache.result = null
})

describe("GET /api/sniper-feed — handler orchestration", () => {
  it("passes deals through and reports marketplaceAvailability + count", async () => {
    cache.result = feed([deal({ editionKey: "1:2", playerName: "Curry" })])
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.deals).toHaveLength(1)
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
  })

  it("filters by editionKey (matching editionKey OR intEditionKey)", async () => {
    cache.result = feed([
      deal({ editionKey: "1:2", playerName: "A" }),
      deal({ editionKey: "9:9", intEditionKey: "1:2", playerName: "B" }),
      deal({ editionKey: "3:4", playerName: "C" }),
    ])
    const res = await GET(get("?collection=nba-top-shot&editionKey=1:2"))
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.deals.map((d: any) => d.playerName).sort()).toEqual(["A", "B"])
  })

  it("filters by player name (case-insensitive substring)", async () => {
    cache.result = feed([
      deal({ playerName: "Stephen Curry" }),
      deal({ playerName: "LeBron James" }),
    ])
    const res = await GET(get("?collection=nba-top-shot&player=curry"))
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.deals[0].playerName).toBe("Stephen Curry")
  })

  it("filters to FLOW/USDC_E payment tokens when flowWalletOnly=true", async () => {
    cache.result = feed([
      deal({ playerName: "A", paymentToken: "FLOW" }),
      deal({ playerName: "B", paymentToken: "DUC" }),
      deal({ playerName: "C", paymentToken: "USDC_E" }),
    ])
    const res = await GET(get("?collection=nba-top-shot&flowWalletOnly=true"))
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.deals.map((d: any) => d.playerName).sort()).toEqual(["A", "C"])
  })

  it("applies the limit slice to the filtered set", async () => {
    cache.result = feed([deal({ playerName: "A" }), deal({ playerName: "B" }), deal({ playerName: "C" })])
    const res = await GET(get("?collection=nba-top-shot&limit=2"))
    const body = await res.json()
    expect(body.deals).toHaveLength(2)
    expect(body.count).toBe(2)
  })

  it("returns an empty feed for a collection with no live source (golazos)", async () => {
    // cache.result null -> factory runs -> the 'other collection' branch returns []
    const res = await GET(get("?collection=laliga-golazos"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toEqual([])
    expect(body.count).toBe(0)
  })
})
