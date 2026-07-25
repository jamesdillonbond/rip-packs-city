import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/fast-break/lineup.
// Auth is cookie-based via requireUser() (throws a 401 Response). We pin the
// pre-DB guards: 401 unauthenticated, 400 malformed JSON, 400 invalid body,
// 400 duplicate players in the body, and one light mocked seam (404 when the
// run row is missing). PLUS the 2xx success path: a valid first-save (run found +
// in range, players eligible, save_fast_break_lineup returns ok) -> 200.

const authState: { user: any } = { user: null }
const state: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }

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
    for (const m of ["select", "eq", "in", "order", "gt", "gte", "lt"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { POST } from "@/app/api/fast-break/lineup/route"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const RUN_ID = "11111111-1111-4111-8111-111111111111"

const req = (body: any, opts: { bad?: boolean } = {}) =>
  ({
    headers: new Headers(),
    nextUrl: new URL("https://t/api/fast-break/lineup"),
    json: async () => {
      if (opts.bad) throw new Error("bad json")
      return body
    },
  }) as any

const validBody = (players: any[]) => ({
  walletAddr: "0xabcdef0123456789",
  runId: RUN_ID,
  gameDate: "2026-07-12",
  players,
})

beforeEach(() => {
  authState.user = { id: "user-1" }
  state.tables = {}
  state.rpc = {}
})

describe("POST /api/fast-break/lineup", () => {
  it("401s when unauthenticated (requireUser throws)", async () => {
    authState.user = null
    const res = await POST(req(validBody([{ nbaPlayerId: UUID_A, momentId: "m1", serial: 1 }])))
    expect(res.status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    const res = await POST(req(null, { bad: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s on an invalid body", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("400s on duplicate nbaPlayerIds in the body", async () => {
    const res = await POST(
      req(
        validBody([
          { nbaPlayerId: UUID_A, momentId: "m1", serial: 1 },
          { nbaPlayerId: UUID_A, momentId: "m2", serial: 2 },
        ]),
      ),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("duplicate_players_in_body")
  })

  it("404s when the run is not found", async () => {
    state.tables.fast_break_runs = { single: { data: null, error: null } }
    const res = await POST(
      req(
        validBody([
          { nbaPlayerId: UUID_A, momentId: "m1", serial: 1 },
          { nbaPlayerId: UUID_B, momentId: "m2", serial: 2 },
        ]),
      ),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("run_not_found")
  })

  it("200s on a valid first-save lineup", async () => {
    state.tables.fast_break_runs = {
      single: {
        data: {
          id: RUN_ID,
          lineup_size: 2,
          has_captain: false,
          start_date: "2026-07-01",
          end_date: "2026-07-31",
        },
        error: null,
      },
    }
    state.tables.fast_break_lineups = { single: { data: null, error: null } }
    state.rpc.get_fb_eligible_players = {
      data: [
        { nba_player_id: UUID_A, highest_tier: "RARE", total_allowed: 3 },
        { nba_player_id: UUID_B, highest_tier: "COMMON", total_allowed: 2 },
      ],
      error: null,
    }
    state.rpc.save_fast_break_lineup = {
      data: {
        ok: true,
        idempotent: false,
        lineup_id: "L1",
        added: [UUID_A, UUID_B],
        removed: [],
        use_counts: [{ nba_player_id: UUID_A, times_used: 1, total_allowed: 3 }],
      },
      error: null,
    }
    const res = await POST(
      req(
        validBody([
          { nbaPlayerId: UUID_A, momentId: "m1", serial: 1 },
          { nbaPlayerId: UUID_B, momentId: "m2", serial: 2 },
        ]),
      ),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.lineupId).toBe("L1")
    expect(body.firstSave).toBe(true)
    expect(body.useCounts[0].nbaPlayerId).toBe(UUID_A)
  })
})

// ---------------------------------------------------------------------------
// The validation ladder past the run lookup, plus the write outcomes. Each of
// these is a distinct 400/409/500 the UI has to distinguish, and none were
// driven before.
// ---------------------------------------------------------------------------

const RUN_OK = {
  single: {
    data: { id: RUN_ID, lineup_size: 2, has_captain: true, start_date: "2026-07-01", end_date: "2026-07-31" },
    error: null,
  },
}
const P = (id: string) => ({ nbaPlayerId: id, momentId: `m-${id}`, serial: 1 })
const eligible = (...ids: string[]) => ({
  data: ids.map((id) => ({ nba_player_id: id, highest_tier: "RARE", total_allowed: 3 })),
  error: null,
})

describe("POST /api/fast-break/lineup — validation ladder", () => {
  beforeEach(() => {
    authState.user = { id: "user-1" }
    state.tables = { fast_break_runs: RUN_OK }
    state.rpc = {
      get_fb_eligible_players: eligible(UUID_A, UUID_B),
      save_fast_break_lineup: { data: { ok: true, lineup_id: "L1", use_counts: [] }, error: null },
    }
  })

  it("400s when the game date falls outside the run window", async () => {
    const res = await POST(req({ ...validBody([P(UUID_A), P(UUID_B)]), gameDate: "2026-09-01" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("game_date_outside_run")
  })

  it("400s when the lineup size does not match the run", async () => {
    const res = await POST(req(validBody([P(UUID_A)]))) // run wants 2
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("lineup_size_mismatch")
    expect(body.detail).toMatchObject({ sent: 1, expected: 2 })
  })

  it("400s when the nominated captain is not in the lineup", async () => {
    const res = await POST(req({
      ...validBody([P(UUID_A), P(UUID_B)]),
      captainNbaPlayerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("captain_not_in_lineup")
  })

  it("500s when the eligibility RPC fails", async () => {
    state.rpc.get_fb_eligible_players = { data: null, error: { message: "elig down" } }
    const res = await POST(req(validBody([P(UUID_A), P(UUID_B)])))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("eligible_rpc_failed")
  })

  it("400s naming the specific ineligible player", async () => {
    state.rpc.get_fb_eligible_players = eligible(UUID_A) // B missing
    const res = await POST(req(validBody([P(UUID_A), P(UUID_B)])))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("player_not_eligible")
    expect(body.playerId).toBe(UUID_B)
  })
})

describe("POST /api/fast-break/lineup — write outcomes", () => {
  beforeEach(() => {
    authState.user = { id: "user-1" }
    state.tables = { fast_break_runs: RUN_OK }
    state.rpc = {
      get_fb_eligible_players: eligible(UUID_A, UUID_B),
      save_fast_break_lineup: { data: { ok: true, lineup_id: "L1", use_counts: [] }, error: null },
    }
  })

  it("500s when the atomic save RPC errors", async () => {
    state.rpc.save_fast_break_lineup = { data: null, error: { message: "write down" } }
    const res = await POST(req(validBody([P(UUID_A), P(UUID_B)])))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("lineup_write_failed")
  })

  it("409s with the offending player when the use budget is exceeded", async () => {
    state.rpc.save_fast_break_lineup = {
      data: { error: "exceeds_use_budget", player_id: UUID_B, times_used: 3, total_allowed: 3 },
      error: null,
    }
    const res = await POST(req(validBody([P(UUID_A), P(UUID_B)])))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ error: "exceeds_use_budget", playerId: UUID_B, timesUsed: 3, totalAllowed: 3 })
  })

  it("reports firstSave when no prior lineup exists for the slot", async () => {
    const body = await (await POST(req(validBody([P(UUID_A), P(UUID_B)])))).json()
    expect(body.ok).toBe(true)
    expect(body.firstSave).toBe(true)
    expect(body.lineupId).toBe("L1")
  })

  it("reports firstSave=false and maps use counts when a lineup already exists", async () => {
    state.tables = {
      fast_break_runs: RUN_OK,
      fast_break_lineups: { single: { data: { players: [{ nbaPlayerId: UUID_A }] }, error: null } },
    }
    state.rpc.save_fast_break_lineup = {
      data: {
        ok: true, idempotent: false, lineup_id: "L1",
        added: [UUID_B], removed: [],
        use_counts: [{ nba_player_id: UUID_A, times_used: 1, total_allowed: 3 }],
      },
      error: null,
    }
    const body = await (await POST(req(validBody([P(UUID_A), P(UUID_B)])))).json()
    expect(body.firstSave).toBe(false)
    expect(body.added).toEqual([UUID_B])
    expect(body.useCounts).toEqual([{ nbaPlayerId: UUID_A, timesUsed: 1, totalAllowed: 3 }])
  })

  it("surfaces an idempotent re-save", async () => {
    state.rpc.save_fast_break_lineup = {
      data: { ok: true, idempotent: true, lineup_id: "L1", use_counts: [] },
      error: null,
    }
    const body = await (await POST(req(validBody([P(UUID_A), P(UUID_B)])))).json()
    expect(body.idempotent).toBe(true)
  })
})
