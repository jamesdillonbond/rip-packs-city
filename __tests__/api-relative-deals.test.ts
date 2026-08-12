import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/relative-deals (GET). getCollectionUuid stays
// real (pure): an unknown/empty collection slug → 400 before any DB call. The
// get_relative_deals RPC is reached via @/lib/supabase's supabaseAdmin.rpc seam;
// pins the happy path (valid slug) and the RPC error → 500.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: state.data, error: state.error }) },
}))

import { GET } from "@/app/api/relative-deals/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/relative-deals", () => {
  it("400s on an unknown collection slug", async () => {
    const res = await GET(req("https://t/api/relative-deals"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("returns deals for a valid collection", async () => {
    state.data = [{ listing_id: "l1", discount_pct: 22 }]
    const res = await GET(
      req("https://t/api/relative-deals?collection=nba-top-shot&minDiscount=15&limit=25")
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("nba-top-shot")
    expect(body.minDiscount).toBe(15)
    expect(body.count).toBe(1)
    expect(body.deals).toHaveLength(1)
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/relative-deals?collection=ufc"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("boom")
  })
})
