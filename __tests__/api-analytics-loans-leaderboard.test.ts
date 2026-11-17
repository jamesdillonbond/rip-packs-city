import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/analytics/loans/leaderboard — wrapper over flowty_analytics_leaderboard(...)
// via rpcWithRetry, then enriches each row with a resolved username. Mocks
// @/lib/flowty-username to avoid the network username resolve. Pins the
// invalid-role 400, the enriched happy path, and rpc-error → 500.

const state: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (state.throws) throw new Error("connection reset")
      return { data: state.data, error: state.error }
    },
  },
}))
vi.mock("@/lib/flowty-username", () => ({
  resolveUsernames: async () => new Map<string, string>([["0xabc", "trevor"]]),
  displayName: (addr: string, names: Map<string, string>) => names.get(addr) ?? addr,
}))

import { GET } from "@/app/api/analytics/loans/leaderboard/route"

const req = (u: string) => ({ url: u }) as any

beforeEach(() => { state.data = null; state.error = null; state.throws = false })

describe("GET /api/analytics/loans/leaderboard", () => {
  it("400s on an invalid role before hitting the DB", async () => {
    const res = await GET(req("https://t/api/analytics/loans/leaderboard?role=whale"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_role")
  })

  it("enriches rows with resolved usernames", async () => {
    state.data = [{ addr: "0xabc", volume: 1000 }]
    const res = await GET(req("https://t/api/analytics/loans/leaderboard?role=lender"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe("lender")
    expect(body.rows[0].username).toBe("trevor")
    expect(body.rows[0].volume).toBe(1000)
  })

  it("500s with leaderboard_failed on an rpc error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req("https://t/api/analytics/loans/leaderboard?role=lender"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("leaderboard_failed")
  })

  it("500s when the rpc throws (outer catch path)", async () => {
    state.throws = true
    const res = await GET(req("https://t/api/analytics/loans/leaderboard?role=lender"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("leaderboard_failed")
  })
})
