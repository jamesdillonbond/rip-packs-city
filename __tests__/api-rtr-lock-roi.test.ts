import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/rtr/lock-roi. requireUser-gated
// (fail-closed 401), then a zod body guard (malformed_json 400, invalid_body
// 400 for a bad walletAddr). Happy path: an authed user + valid wallet whose
// wallet_moments_cache is empty short-circuits to the empty payload.
//
// The supabase mock is table + page + .in()-aware: state.tables[<table>] is the
// backing array, .range(from,to) slices it, and .in(col, vals) filters it. This
// lets the whale test below prove the wmc read pages past the PostgREST 1,000-row
// cap (a bare .select() clamps at 1,000; the route pages with .range()).

const state: { user: any; tables: Record<string, any[]> } = { user: null, tables: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    let rng: [number, number] | null = null
    let inCol: string | null = null
    let inVals: any[] | null = null
    const b: any = {
      select: () => b,
      eq: () => b,
      in: (col: string, vals: any[]) => {
        inCol = col
        inVals = vals
        return b
      },
      order: () => b,
      range: (from: number, to: number) => {
        rng = [from, to]
        return b
      },
      then: (resolve: any) => {
        let all = state.tables[table] ?? []
        if (inVals && inCol) all = all.filter((r: any) => inVals!.includes(r[inCol!]))
        // Simulate PostgREST's hard 1,000-row cap: a windowed .range() read
        // returns its slice, but a bare (unbounded) read clamps at 1,000. This
        // is what makes the whale test a real regression guard — the pre-fix
        // unbounded wmc fetch would come back clamped to 1,000 here.
        const data = rng ? all.slice(rng[0], rng[1] + 1) : all.slice(0, 1000)
        return resolve({ data, error: null })
      },
    }
    return b
  }
  const admin: any = { from: (t: string) => makeBuilder(t) }
  return { supabaseAdmin: admin, supabase: admin }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { POST } from "@/app/api/rtr/lock-roi/route"

function post(body: string): NextRequest {
  return new NextRequest("https://t/api/rtr/lock-roi", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  })
}

beforeEach(() => {
  state.user = null
  state.tables = {}
})

describe("POST /api/rtr/lock-roi", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(post(JSON.stringify({ walletAddr: "0x0000000000000001" })))
    expect(res.status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    state.user = { id: "u1" }
    const res = await POST(post("{not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s invalid_body on a bad walletAddr", async () => {
    state.user = { id: "u1" }
    const res = await POST(post(JSON.stringify({ walletAddr: "nope" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("returns the empty payload for an authed user with no cached moments", async () => {
    state.user = { id: "u1" }
    state.tables.wallet_moments_cache = []
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000Ab" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.walletAddr).toBe("0x00000000000000ab") // lower-cased
    expect(body.rowCount).toBe(0)
    expect(body.totalAvailable).toBe(0)
    expect(body.moments).toEqual([])
  })

  it("does not truncate a whale (>1000 cached moments) at the PostgREST 1000-row cap", async () => {
    state.user = { id: "u1" }
    // 1,500 moments across two .range() pages (1000 + 500). Each carries
    // fmv_usd > 0, so it survives the fmv>0 filter via the fallback path
    // (editions / fmv_current tables left empty → no fresh FMV, use r.fmv_usd).
    // If the wmc read still clamped at 1,000, totalAvailable would read 1,000.
    state.tables.wallet_moments_cache = Array.from({ length: 1500 }, (_, i) => ({
      moment_id: `m${i}`,
      edition_key: `E${i % 50}`,
      player_name: `Player ${i}`,
      set_name: "Set A",
      tier: "COMMON",
      is_locked: false,
      fmv_usd: 50,
      serial_number: i + 1,
    }))
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000ff" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    // All 1,500 have valid FMV → the full set is ranked, not a 1,000-row clamp.
    expect(body.totalAvailable).toBe(1500)
    // rowCount is capped at ROW_CAP (200) for display.
    expect(body.rowCount).toBe(200)
    expect(body.moments).toHaveLength(200)
  })

  // v2 playoff-points model: estimate scales with tier and serial scarcity,
  // not just FMV, so points-per-dollar is no longer a flat constant. Each test
  // uses a fresh walletAddr because the route's 5-minute in-process cache is
  // module-scoped and not cleared between tests. editions / fmv_current are
  // left empty so FMV comes from the wallet_moments_cache fallback (r.fmv_usd).
  it("ranks a rarer tier above a common at equal FMV (tier folds into the estimate)", async () => {
    state.user = { id: "u1" }
    state.tables.wallet_moments_cache = [
      { moment_id: "mC", edition_key: "E1", player_name: "P", set_name: "S", tier: "COMMON", is_locked: true, fmv_usd: 100, serial_number: 500 },
      { moment_id: "mL", edition_key: "E2", player_name: "P", set_name: "S", tier: "LEGENDARY", is_locked: true, fmv_usd: 100, serial_number: 500 },
    ]
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000a1" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    // Sorted by pointsPerDollar desc → the LEGENDARY leads.
    expect(body.moments[0].tier).toBe("LEGENDARY")
    const legend = body.moments.find((m: any) => m.tier === "LEGENDARY")
    const common = body.moments.find((m: any) => m.tier === "COMMON")
    expect(legend.estimatedPlayoffPoints).toBeGreaterThan(common.estimatedPlayoffPoints)
    expect(legend.pointsPerDollar).toBeGreaterThan(common.pointsPerDollar)
  })

  it("ranks a lower serial above a higher one at equal FMV and tier (scarcity folds in)", async () => {
    state.user = { id: "u1" }
    state.tables.wallet_moments_cache = [
      { moment_id: "mHi", edition_key: "E1", player_name: "P", set_name: "S", tier: "RARE", is_locked: true, fmv_usd: 100, serial_number: 8000 },
      { moment_id: "mLo", edition_key: "E1", player_name: "P", set_name: "S", tier: "RARE", is_locked: true, fmv_usd: 100, serial_number: 1 },
    ]
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000a2" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments[0].serialNumber).toBe(1)
    const low = body.moments.find((m: any) => m.serialNumber === 1)
    const high = body.moments.find((m: any) => m.serialNumber === 8000)
    expect(low.pointsPerDollar).toBeGreaterThan(high.pointsPerDollar)
  })

  it("does not zero out a sub-$10 moment's points-per-dollar (v1 floor(fmv/10) bug)", async () => {
    state.user = { id: "u1" }
    state.tables.wallet_moments_cache = [
      { moment_id: "mCheap", edition_key: "E1", player_name: "P", set_name: "S", tier: "COMMON", is_locked: true, fmv_usd: 5, serial_number: 500 },
    ]
    const res = await POST(post(JSON.stringify({ walletAddr: "0x00000000000000a3" })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments).toHaveLength(1)
    // Under v1, floor(5/10)=0 → pointsPerDollar 0 and the row sank to the
    // bottom with "0 est pts". v2 keeps a real ratio (~tierWeight/10).
    expect(body.moments[0].pointsPerDollar).toBeGreaterThan(0)
  })

  it("exports a POST function", () => {
    expect(typeof POST).toBe("function")
  })
})
