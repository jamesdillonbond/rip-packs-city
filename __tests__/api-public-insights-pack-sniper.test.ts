import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/pack-sniper. The handler gates
// on isSupportedPackCollection then wraps getPackDeals; mock both
// @/lib/packs/live-pack-listings (guard) and @/lib/packs/pack-deals (data). Pins
// the unsupported-collection 400, the happy path, and the thrown-error → 500.

const state: { supported: boolean; result: any; err: Error | null } = {
  supported: true,
  result: { stats: { returned: 0, matched: 0, positiveEv: 0, highVariance: 0, liveListings: 0 }, deals: [] },
  err: null,
}

vi.mock("@/lib/packs/live-pack-listings", () => ({
  SUPPORTED_PACK_COLLECTIONS: ["nba-top-shot", "nfl-all-day"],
  isSupportedPackCollection: (_slug: string) => state.supported,
}))
vi.mock("@/lib/packs/pack-deals", () => ({
  getPackDeals: async () => { if (state.err) throw state.err; return state.result },
}))

import { GET } from "@/app/api/public/insights/pack-sniper/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/pack-sniper"

beforeEach(() => {
  state.supported = true
  state.result = { stats: { returned: 0, matched: 0, positiveEv: 0, highVariance: 0, liveListings: 0 }, deals: [] }
  state.err = null
})

describe("GET /api/public/insights/pack-sniper", () => {
  it("400s on an unsupported collection", async () => {
    state.supported = false
    const res = await GET(req(`${base}?collection=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("returns deals + stats on the happy path", async () => {
    state.result = {
      stats: { returned: 3, matched: 3, positiveEv: 2, highVariance: 1, liveListings: 40 },
      deals: [{ pack_listing_id: "p1", value_ratio: 1.3 }],
    }
    const res = await GET(req(`${base}?collection=nba-top-shot&limit=20`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals).toHaveLength(1)
    expect(body.meta.stats.returned).toBe(3)
    expect(body.meta.filters).toMatchObject({ limit: 20, include_high_variance: true })
  })

  it("honors include_high_variance=false in the echoed filters", async () => {
    const res = await GET(req(`${base}?include_high_variance=false`))
    expect(res.status).toBe(200)
    expect((await res.json()).meta.filters.include_high_variance).toBe(false)
  })

  it("500s when getPackDeals throws", async () => {
    state.err = new Error("sniper down")
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("sniper down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
