import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/public/insights/autographs. The handler validates the
// collection (an unknown one is REFUSED — never answered with another
// collection's rows), defaults the sort, clamps the limit NaN-safely, and maps a
// failed read to the shared 503 envelope with no driver text.

const state: { result: { data: any[] | null; error: any }; throwErr: Error | null; lastOpts: any } = {
  result: { data: [], error: null },
  throwErr: null,
  lastOpts: null,
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/insights/autographs-board", async (orig) => {
  const actual = await orig<typeof import("@/lib/insights/autographs-board")>()
  return {
    ...actual,
    fetchAutographsBoard: async (_db: any, opts: any) => {
      state.lastOpts = opts
      if (state.throwErr) throw state.throwErr
      return state.result
    },
  }
})

import { GET } from "@/app/api/public/insights/autographs/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/autographs"

beforeEach(() => {
  state.result = { data: [], error: null }
  state.throwErr = null
  state.lastOpts = null
})

describe("GET /api/public/insights/autographs", () => {
  it("returns rows and echoes the normalized filters", async () => {
    state.result = { data: [{ edition_id: "e1", external_id: "219:7408::18", low_ask: 2999 }], error: null }
    const res = await GET(req(`${base}?collection=nfl_all_day&sort=premium&limit=25`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.source).toBe("v_insights_autographs")
    expect(body.meta.filters).toMatchObject({ collection: "nfl_all_day", sort: "premium", limit: 25 })
    expect(state.lastOpts).toMatchObject({ collection: "nfl_all_day", sort: "premium", limit: 25 })
  })

  it("defaults sort and limit (NaN-safe) and treats sort=listed as listed-only", async () => {
    const res = await GET(req(`${base}?sort=bogus&limit=abc`))
    const body = await res.json()
    expect(body.meta.filters).toMatchObject({ collection: "nba_top_shot", sort: "listed", listed: true, limit: 200 })
  })

  it("REFUSES an unsupported collection instead of substituting Top Shot", async () => {
    const res = await GET(req(`${base}?collection=laliga_golazos`))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(state.lastOpts).toBeNull()
  })

  it("a failed read is the board-unavailable envelope, never an empty board", async () => {
    state.result = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req(base))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("statement timeout")
  })

  it("a thrown read is the same envelope", async () => {
    state.throwErr = new Error("pool exhausted")
    const res = await GET(req(base))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toContain("pool exhausted")
  })
})
