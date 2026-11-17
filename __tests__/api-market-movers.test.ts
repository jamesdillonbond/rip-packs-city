import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-movers (GET, no auth / no params).
// Thin wrapper over the get_fmv_movers RPC. Mocks @supabase/supabase-js
// createClient. Pins the happy path, the genuine-empty fallback, and — since
// 2026-08-21 — that a FAILURE is not published as a quiet market.
//
// ⚠ THE THIRD CASE HERE WAS INVERTED, NOT ADDED. It used to read "swallows an
// RPC throw to an empty movers list", and the header used to describe that
// swallow as the contract. A passing test asserting a promise is what holds
// that promise in place: "no movers in the last 24 hours" is a MARKET CLAIM,
// and this response carries `s-maxage=300`, so one failed read was served to
// every visitor for five minutes. Inverted rather than deleted, per the repo
// rule, so the defect cannot come back unnoticed.

const state: { data: any; error: any; throws: boolean } = { data: [], error: null, throws: false }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => {
      if (state.throws) throw new Error("rpc threw")
      return { data: state.data, error: state.error }
    },
  }),
}))

import { GET } from "@/app/api/market-movers/route"

beforeEach(() => {
  state.data = []
  state.error = null
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

  it("still returns an empty movers list when the market GENUINELY had none", async () => {
    // The control. An empty list is a real answer; it just has to be earned by a
    // query that came back empty. Without this, the two cases above would be
    // satisfied by a route that 500s unconditionally.
    state.data = null
    state.error = null
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).movers).toEqual([])
  })

  it("does NOT swallow an RPC throw into an empty movers list", async () => {
    state.throws = true
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).movers).toBeUndefined()
  })

  it("does NOT swallow a returned RPC error into an empty movers list", async () => {
    // supabase-js RETURNS errors rather than throwing, so this is the path the
    // throw-case above never covered — and the one the live RPC actually takes.
    state.data = null
    state.error = { message: "statement timeout" }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).movers).toBeUndefined()
  })
})
