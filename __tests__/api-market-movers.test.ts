import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-movers (GET, no auth / no params).
// Thin wrapper over the get_fmv_movers RPC; on any throw it swallows to
// { movers: [] }. Mocks @supabase/supabase-js createClient. Pins the happy path
// and the null-data fallback.

const state: { data: any; throws: boolean } = { data: [], throws: false }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => {
      if (state.throws) throw new Error("rpc threw")
      return { data: state.data }
    },
  }),
}))

import { GET } from "@/app/api/market-movers/route"

beforeEach(() => {
  state.data = []
  state.throws = false
})

describe("GET /api/market-movers", () => {
  it("returns the movers rows from the RPC", async () => {
    state.data = [{ edition_id: "u1", change_pct: 12 }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.movers).toHaveLength(1)
    expect(body.movers[0].edition_id).toBe("u1")
  })

  it("falls back to an empty movers list when the RPC returns null data", async () => {
    state.data = null
    const body = await (await GET()).json()
    expect(body.movers).toEqual([])
  })

  it("swallows an RPC throw to an empty movers list", async () => {
    state.throws = true
    const body = await (await GET()).json()
    expect(body.movers).toEqual([])
  })
})
