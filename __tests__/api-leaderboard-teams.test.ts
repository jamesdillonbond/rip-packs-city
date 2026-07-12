import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/leaderboard/teams (GET).
// Guard: ?league must satisfy isLeague (NBA/WNBA/NFL/LALIGA) else 400. Backed by
// the get_team_fan_leaderboard RPC. Pins the league 400, the happy path (RPC
// rows sliced by limit), and the RPC-error 500.

const state: { rpc: any } = { rpc: { data: [], error: null } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => state.rpc },
}))

import { GET } from "@/app/api/leaderboard/teams/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
})

describe("GET /api/leaderboard/teams", () => {
  it("400s when league is missing", async () => {
    const res = await GET(req("https://t/api/leaderboard/teams"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("league must be one of")
  })

  it("400s on an invalid league", async () => {
    const res = await GET(req("https://t/api/leaderboard/teams?league=MLB"))
    expect(res.status).toBe(400)
  })

  it("returns a leaderboard for a valid league, sliced by limit", async () => {
    state.rpc = {
      data: [
        { team: "a", fan_count: 3 },
        { team: "b", fan_count: 2 },
        { team: "c", fan_count: 1 },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/leaderboard/teams?league=NBA&limit=2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.league).toBe("NBA")
    expect(body.leaderboard).toHaveLength(2)
  })

  it("500s when the RPC errors", async () => {
    state.rpc = { data: null, error: { message: "boom" } }
    const res = await GET(req("https://t/api/leaderboard/teams?league=NFL"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("boom")
  })
})
