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

  it("500s when the uses query errors", async () => {
    state.tables.fast_break_player_uses = { list: { data: null, error: { message: "uses down" } } }
    const res = await GET(req(`?runId=${RUN_ID}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("internal_error")
  })

  it("enriches use rows with player meta and computes remainingUses", async () => {
    state.tables.fast_break_player_uses = {
      list: {
        data: [{
          nba_player_id: "p1", highest_tier_owned: "RARE", total_allowed: 5, times_used: 2,
          dates_used: ["2026-07-01"], best_moment_id: "m1", best_serial: 7, updated_at: "t",
        }],
        error: null,
      },
    }
    state.tables.nba_players = { list: { data: [{ id: "p1", full_name: "Luka Doncic", current_team_abbr: "POR" }], error: null } }
    const res = await GET(req(`?runId=${RUN_ID}`))
    expect(res.status).toBe(200)
    const { uses } = await res.json()
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({
      nbaPlayerId: "p1",
      fullName: "Luka Doncic",
      teamAbbr: "POR",
      totalAllowed: 5,
      timesUsed: 2,
      remainingUses: 3, // max(0, 5 - 2)
      bestSerial: 7,
    })
  })

  it("clamps remainingUses at 0 when a player is over their allowance", async () => {
    state.tables.fast_break_player_uses = {
      list: { data: [{ nba_player_id: "p2", total_allowed: 2, times_used: 5, dates_used: null }], error: null },
    }
    state.tables.nba_players = { list: { data: [], error: null } } // no meta → null identity
    const { uses } = await GET(req(`?runId=${RUN_ID}`)).then((r) => r.json())
    expect(uses[0].remainingUses).toBe(0)
    expect(uses[0].fullName).toBeNull()
    expect(uses[0].datesUsed).toEqual([]) // null → []
  })
})
