import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/new-collectors. The handler is
// a thin wrapper over fetchNewCollectorsBoard(supabase) shaping four MVs; mock
// @/lib/new-collectors-board (and @/lib/supabase). No auth guard — pins the
// happy path (all four sections + coverage note) and the thrown-error → 500 path.

const state: { board: any; err: Error | null } = { board: null, err: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/new-collectors-board", () => ({
  COVERAGE_NOTE: "coverage caveat",
  fetchNewCollectorsBoard: async () => { if (state.err) throw state.err; return state.board },
}))

import { GET } from "@/app/api/public/insights/new-collectors/route"

const req = (u = "https://t/api/public/insights/new-collectors") => ({ url: u, nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.err = null
  state.board = { computed_at: "2026-07-12T00:00:00Z", summary: [], spend: [], gateway: [], cohorts: [] }
})

describe("GET /api/public/insights/new-collectors", () => {
  it("returns the four board sections + coverage note on the happy path", async () => {
    state.board = {
      computed_at: "2026-07-12T00:00:00Z",
      summary: [{ window: "24h", active: 100 }],
      spend: [{ window: "24h", usd: 5000 }],
      gateway: [{ pack: "base", n: 10 }],
      cohorts: [{ cohort: "2026-07", retained: 42 }],
    }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary).toHaveLength(1)
    expect(body.cohorts).toHaveLength(1)
    expect(body.meta.coverage_note).toBe("coverage caveat")
    expect(body.meta.computed_at).toBe("2026-07-12T00:00:00Z")
  })

  it("returns empty sections when the board is empty", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary).toEqual([])
    expect(body.spend).toEqual([])
  })

  it("500s when fetchNewCollectorsBoard throws", async () => {
    state.err = new Error("board down")
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("board down")
  })

  it("500s and String()-coerces a non-Error throw", async () => {
    state.err = "raw collectors failure" as unknown as Error
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("raw collectors failure")
  })
})
