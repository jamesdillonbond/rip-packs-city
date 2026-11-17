import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/tier-pricing-benchmarks. Wraps
// get_tier_pricing_benchmarks; an unknown collection slug → 400 (getCollectionUuid),
// a valid slug returns the benchmarks payload, and an RPC error → 500. Mocks
// supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: {}, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/tier-pricing-benchmarks/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = {}; rpc.error = null })

describe("GET /api/tier-pricing-benchmarks", () => {
  it("400s on an unknown collection", async () => {
    expect((await GET(req("https://t/api/tier-pricing-benchmarks"))).status).toBe(400)
    expect((await GET(req("https://t/api/tier-pricing-benchmarks?collection=not-real"))).status).toBe(400)
  })

  it("returns benchmarks for a valid collection", async () => {
    rpc.data = { RARE: { count: 5, floor: 10 } }
    const res = await GET(req("https://t/api/tier-pricing-benchmarks?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("nba-top-shot")
    expect(body.benchmarks.RARE.count).toBe(5)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db" }
    expect((await GET(req("https://t/api/tier-pricing-benchmarks?collection=nba-top-shot"))).status).toBe(500)
  })
})
