import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/pack-listings/historical-pulls.
// Reads moment_acquisitions (pack_pull) then batches wallet_moments_cache to
// count pulls by tier for editions whose set_name loosely matches ?title.
// Pins: missing-title 400, the error/empty short-circuit (total 0), and a
// loose-match happy path that tallies a tier bucket.

const state: { pulls: any; pullsErr: any; wmc: any } = { pulls: [], pullsErr: null, wmc: [] }

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () =>
      table === "moment_acquisitions"
        ? { data: state.pulls, error: state.pullsErr }
        : { data: state.wmc, error: null }
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { GET } from "@/app/api/pack-listings/historical-pulls/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.pulls = []
  state.pullsErr = null
  state.wmc = []
})

describe("GET /api/pack-listings/historical-pulls", () => {
  it("400s when title is missing", async () => {
    const res = await GET(req("https://t/api/pack-listings/historical-pulls"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("title required")
  })

  it("returns total 0 when the acquisitions query errors", async () => {
    state.pullsErr = { message: "db" }
    const res = await GET(req("https://t/api/pack-listings/historical-pulls?title=Metallic+Gold"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 0, tierBreakdown: {} })
  })

  it("returns total 0 when there are no pulls", async () => {
    state.pulls = []
    const res = await GET(req("https://t/api/pack-listings/historical-pulls?title=Metallic+Gold"))
    const body = await res.json()
    expect(body.total).toBe(0)
    expect(body.tierBreakdown).toEqual({})
  })

  it("tallies matching pulls by tier on a loose set-name match", async () => {
    state.pulls = [{ nft_id: "1", acquisition_method: "pack_pull" }]
    state.wmc = [{ moment_id: "1", tier: "MOMENT_TIER_RARE", set_name: "Metallic Gold LE" }]
    const res = await GET(req("https://t/api/pack-listings/historical-pulls?title=Metallic+Gold"))
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.tierBreakdown).toEqual({ RARE: 1 })
  })
})
