import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/rtr/picks/today. Public, unauthenticated.
// The route delegates entirely to pickTonightsBest(supabaseAdmin, ...); we mock
// that lib seam to pin both branches: no fresh odds → picks:[] +
// message:"no_fresh_odds", and a top pick → a single-element picks array.

const state: { top: any } = { top: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/rtr-picks", () => ({
  pickTonightsBest: async () => state.top,
}))

import { GET } from "@/app/api/rtr/picks/today/route"

beforeEach(() => {
  state.top = null
})

describe("GET /api/rtr/picks/today", () => {
  it("returns the no_fresh_odds fallback when there is no pick", async () => {
    state.top = null
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.picks).toEqual([])
    expect(body.message).toBe("no_fresh_odds")
  })

  it("returns a single recommended pick when one exists", async () => {
    state.top = {
      gameId: "g1",
      homeTeam: "POR",
      awayTeam: "LAL",
      recommendedSide: "home_ml",
      impliedProbability: 0.62,
      rationale: "Home favorite POR over LAL at 62% implied probability",
      homeML: -150,
      awayML: 130,
      tipoffAt: "2026-07-12T02:00:00Z",
      bookmaker: "draftkings",
      oddsLastSyncedAt: "2026-07-12T00:00:00Z",
    }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.picks).toHaveLength(1)
    expect(body.picks[0]).toMatchObject({ gameId: "g1", recommendedSide: "home_ml", impliedProbability: 0.62 })
  })

  it("exports a GET function", () => {
    expect(typeof GET).toBe("function")
  })
})
