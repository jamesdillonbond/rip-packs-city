import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/fast-break/today.
// No auth — public run + slate read. We mock @/lib/supabase's chained builder
// and pin the three clean seams: no active run, a run-lookup error (500), and
// an active run with no games today.

const state: { tables: Record<string, any> } = { tables: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "gt", "gte", "lt"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = { from: (t: string) => makeBuilder(t) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/fast-break/today/route"

const RUN = {
  id: "run-1",
  name: "Playoff Push",
  lineup_size: 3,
  has_captain: true,
  start_date: "2026-07-01",
  end_date: "2026-07-31",
}

beforeEach(() => {
  state.tables = {}
})

describe("GET /api/fast-break/today", () => {
  it("returns runId=null when there is no active run", async () => {
    state.tables.fast_break_runs = { single: { data: null, error: null } }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runId).toBeNull()
    expect(body.message).toBe("no_active_run")
  })

  it("500s on a run-lookup error", async () => {
    state.tables.fast_break_runs = { single: { data: null, error: { message: "db down" } } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("internal_error")
  })

  it("returns no_games_today for an active run with an empty slate", async () => {
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.nba_games = { list: { data: [], error: null } }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runId).toBe("run-1")
    expect(body.message).toBe("no_games_today")
    expect(body.games).toEqual([])
  })

  it("500s on a games-lookup error", async () => {
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.nba_games = { list: { data: null, error: { message: "games down" } } }
    expect((await GET()).status).toBe(500)
  })

  it("500s on a projections-lookup error", async () => {
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.nba_games = { list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "t", status: "s" }], error: null } }
    state.tables.nba_player_projections = { list: { data: null, error: { message: "proj down" } } }
    expect((await GET()).status).toBe(500)
  })

  it("returns games + projections joined with player meta + opponent on the happy path", async () => {
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.nba_games = {
      list: { data: [{ id: "g1", external_game_id: "x1", game_date: "2026-07-20", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "t", status: "scheduled" }], error: null },
    }
    state.tables.nba_player_projections = {
      list: { data: [{ nba_player_id: "p1", game_id: "g1", proj_fp_dk: 50, proj_minutes: 34, injury_status: "ACTIVE" }], error: null },
    }
    state.tables.nba_players = {
      list: { data: [{ id: "p1", full_name: "Luka Doncic", current_team_abbr: "POR", position: "G" }], error: null },
    }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.games).toHaveLength(1)
    expect(body.games[0]).toMatchObject({ gameId: "g1", homeTeam: "POR", awayTeam: "LAL" })
    expect(body.projections).toHaveLength(1)
    expect(body.projections[0]).toMatchObject({
      nbaPlayerId: "p1",
      fullName: "Luka Doncic",
      teamAbbr: "POR",
      opponentTeam: "LAL", // POR is home → opponent is away LAL
      projFp: 50,
      position: "G",
    })
  })

  it("500s on a player-META lookup error rather than publishing nameless projections", async () => {
    // The only read in this route whose error was not destructured. Before the
    // fix it returned HTTP 200 with the projection present and fullName,
    // teamAbbr, position AND opponentTeam all null — the "read ok +
    // unrenderable" third state, published as data and logged nowhere.
    // opponentTeam goes null too because its branch is gated on teamAbbr, so a
    // single failed join silently emptied four fields.
    //
    // The happy path directly above is the control: same shape, error: null,
    // and every one of those four fields populated. Without it, "500 on error"
    // would be satisfied by a route that 500s unconditionally.
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.nba_games = {
      list: { data: [{ id: "g1", external_game_id: "x1", game_date: "2026-07-20", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "t", status: "scheduled" }], error: null },
    }
    state.tables.nba_player_projections = {
      list: { data: [{ nba_player_id: "p1", game_id: "g1", proj_fp_dk: 50, proj_minutes: 34, injury_status: "ACTIVE" }], error: null },
    }
    state.tables.nba_players = { list: { data: null, error: { message: "statement timeout" } } }
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("internal_error")
    // And specifically NOT a 200 carrying a projection with a null name.
    expect(body.projections).toBeUndefined()
  })
})
