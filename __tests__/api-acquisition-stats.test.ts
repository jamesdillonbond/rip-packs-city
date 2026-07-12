import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/acquisition-stats.
// Guard: `wallet` query param required → 400. Otherwise resolves a collection id
// then calls the get_acquisition_stats RPC. Mock @/lib/supabase to pin the guard
// plus the happy path (RPC row passthrough) and the RPC-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    single: async () => ({ data: { id: "col-1" } }),
    rpc: async () => ({ data: rpc.data, error: rpc.error }),
  }
  return { supabaseAdmin: b }
})

import { GET } from "@/app/api/acquisition-stats/route"

function req(qs = ""): NextRequest {
  return new NextRequest("https://t/api/acquisition-stats" + qs)
}

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/acquisition-stats", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet parameter required")
  })

  it("returns the RPC row for a wallet", async () => {
    rpc.data = [{ total_moments: 12, total_spent: 340, locked_count: 2, breakdown: [] }]
    const res = await GET(req("?wallet=0xabc&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).total_moments).toBe(12)
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "boom" }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })
})
