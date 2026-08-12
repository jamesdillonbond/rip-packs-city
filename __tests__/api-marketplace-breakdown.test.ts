import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/marketplace-breakdown (GET). No auth. Wraps
// get_marketplace_breakdown(p_wallet, p_collection_id). Mocks @/lib/supabase
// supabaseAdmin.rpc. Pins the missing-wallet 400, the array-first happy path,
// and rpc error → 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/marketplace-breakdown/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/marketplace-breakdown", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/marketplace-breakdown"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("returns the first row of the rpc result array", async () => {
    rpc.data = [{ total: 5 }, { total: 99 }]
    const res = await GET(req("https://t/api/marketplace-breakdown?wallet=0xabc"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 5 })
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/marketplace-breakdown?wallet=abc"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("db down")
  })
})
