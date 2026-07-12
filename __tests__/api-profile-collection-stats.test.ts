import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/collection-stats.
// Public read (no auth). Requires ?wallet_addr → 400. Delegates to the
// get_wallet_collection_stats RPC; a 57014 (statement_timeout) error maps to
// 503, any other error to 500, success to 200 { stats }.

const rpc: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/profile/collection-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = []
  rpc.error = null
})

describe("GET /api/profile/collection-stats", () => {
  it("400s without wallet_addr", async () => {
    const res = await GET(req("https://t/api/profile/collection-stats"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr required")
  })

  it("returns per-collection stats for a wallet", async () => {
    rpc.data = [{ collection_id: "c1", moment_count: 3 }]
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet_addr).toBe("0xabc") // lower-cased
    expect(body.stats).toHaveLength(1)
  })

  it("maps a 57014 statement-timeout to 503 with retry", async () => {
    rpc.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(503)
    expect((await res.json()).retry).toBe(true)
  })

  it("500s on any other RPC error", async () => {
    rpc.error = { code: "12345", message: "boom" }
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(500)
  })
})
