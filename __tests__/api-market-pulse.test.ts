import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-pulse (GET, no auth / no params).
// Thin wrapper over the get_market_pulse_all RPC. Pins the happy path and the
// RPC-error 500.

const state: { rpc: any } = { rpc: { data: [], error: null } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => state.rpc },
}))

import { GET } from "@/app/api/market-pulse/route"

beforeEach(() => {
  state.rpc = { data: [], error: null }
})

describe("GET /api/market-pulse", () => {
  it("returns the pulse rows from the RPC", async () => {
    state.rpc = { data: [{ collection: "nba_top_shot", volume: 100 }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].collection).toBe("nba_top_shot")
  })

  it("500s when the RPC errors", async () => {
    state.rpc = { data: null, error: { message: "pulse down" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Query failed")
  })
})
