import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/fast-break/uses.
// Cookie-auth via requireUser() + a runId uuid query guard. Pins: 401
// unauthenticated, 400 invalid query (missing / non-uuid runId), and the
// authed empty-state happy path (no use rows → uses: []).

const authState: { user: any } = { user: null }
const state: { tables: Record<string, any> } = { tables: {} }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (authState.user) return authState.user
    throw new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  },
}))

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = { from: (t: string) => makeBuilder(t) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/fast-break/uses/route"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const req = (qs: string) => ({ nextUrl: new URL("https://t/api/fast-break/uses" + qs) }) as any

beforeEach(() => {
  authState.user = { id: "user-1" }
  state.tables = {}
})

describe("GET /api/fast-break/uses", () => {
  it("401s when unauthenticated", async () => {
    authState.user = null
    const res = await GET(req(`?runId=${RUN_ID}`))
    expect(res.status).toBe(401)
  })

  it("400s when runId is missing", async () => {
    const res = await GET(req(""))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_query")
  })

  it("400s when runId is not a uuid", async () => {
    const res = await GET(req("?runId=not-a-uuid"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_query")
  })

  it("returns an empty uses list for an authed user with no rows", async () => {
    state.tables.fast_break_player_uses = { list: { data: [], error: null } }
    const res = await GET(req(`?runId=${RUN_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runId).toBe(RUN_ID)
    expect(body.uses).toEqual([])
  })
})
