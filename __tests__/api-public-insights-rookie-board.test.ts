import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/rookie-board. The handler runs
// two in-route param guards (tier allowlist, parallel_id non-negative integer)
// then wraps fetchRookieEditionBoard(supabase, opts); mock @/lib/rookie-edition-
// board (and @/lib/supabase). Pins both 400 guards, the happy path, and error → 500.

const state: { rows: any[]; err: Error | null } = { rows: [], err: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/rookie-edition-board", () => ({
  fetchRookieEditionBoard: async () => { if (state.err) throw state.err; return state.rows },
}))

import { GET } from "@/app/api/public/insights/rookie-board/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/rookie-board"

beforeEach(() => { state.rows = []; state.err = null })

describe("GET /api/public/insights/rookie-board", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${base}?tier=SUPER`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("400s on a non-integer parallel_id", async () => {
    const res = await GET(req(`${base}?parallel_id=-3`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("parallel_id must be a non-negative integer")
  })

  it("returns rows with echoed filters (burn mode defaults sort=burned)", async () => {
    state.rows = [{ external_id: "8:145", burned: 120 }]
    const res = await GET(req(`${base}?mode=burn&tier=rare&limit=100`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.mode).toBe("burn")
    expect(body.meta.filters).toMatchObject({ mode: "burn", tier: "RARE", sort: "burned", limit: 100 })
  })

  it("returns an empty rows array when the board has nothing", async () => {
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s when fetchRookieEditionBoard throws", async () => {
    state.err = new Error("rookie board down")
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("rookie board down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
