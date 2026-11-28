import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/cron/fast-break-predictions — stores the whole-slate best lineup BEFORE first tipoff and
// scores past nights from box scores. Pins: no write after tipoff (it would leak the answer),
// a failed read makes the run not-ok (never a quiet green), and scoring writes only scored rows.

const state: { tables: Record<string, any>; writes: Array<{ table: string; op: string; row: any }>; runs: any[] } = {
  tables: {}, writes: [], runs: [],
}

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "not", "is", "lt", "order"]) b[m] = () => b
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    b.upsert = async (row: any) => { state.writes.push({ table, op: "upsert", row }); return state.tables[table]?.write ?? { error: null } }
    b.update = (row: any) => {
      state.writes.push({ table, op: "update", row })
      const u: any = {}
      u.eq = () => u
      u.then = (resolve: any) => resolve(state.tables[table]?.write ?? { error: null })
      return u
    }
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string, args: any) => { if (name === "log_pipeline_run") state.runs.push(args); return { error: null } },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/cron/fast-break-predictions/route"

const RUN = { id: "11111111-1111-4111-8111-111111111111", lineup_size: 5, has_captain: true, start_date: "2026-11-16", end_date: "2026-11-29" }
const req = (auth = "Bearer test-cron") => ({ headers: new Headers({ authorization: auth }) }) as any

function slate(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
  return {
    ids,
    proj: ids.map((id, i) => ({ nba_player_id: id, game_id: "g1", injury_status: "ACTIVE", proj_points: 20 + i })),
    meta: ids.map((id, i) => ({ id, full_name: `Player ${i}`, current_team_abbr: "POR" })),
  }
}

beforeEach(() => {
  state.tables = {}
  state.writes = []
  state.runs = []
  process.env.CRON_SECRET = "test-cron"
  vi.useRealTimers()
})

describe("GET /api/cron/fast-break-predictions", () => {
  it("401s without the cron secret and logs nothing", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    expect(state.runs).toHaveLength(0)
  })

  it("stores tonight's whole-slate lineup before first tipoff", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T17:00:00Z"), toFake: ["Date"] })
    const s = slate(7)
    state.tables.fast_break_runs = { list: { data: [RUN], error: null } }
    state.tables.nba_games = { list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL", tipoff_at: "2026-11-29T03:00:00Z" }], error: null } }
    state.tables.nba_player_projections = { list: { data: s.proj, error: null } }
    state.tables.nba_players = { list: { data: s.meta, error: null } }
    state.tables.fast_break_nights = { single: { data: { objective: "Combine for 110 Points", targets: { pts: 110 } }, error: null } }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const up = state.writes.filter(w => w.op === "upsert")
    expect(up).toHaveLength(1)
    expect(up[0].row.game_date).toBe("2026-11-28")
    expect(up[0].row.players.filter((p: any) => !p.bench)).toHaveLength(5)
    expect(up[0].row.players.filter((p: any) => p.captain)).toHaveLength(1)
    expect(up[0].row.predicted_p).toBeGreaterThan(0)
    expect(state.runs[0]).toMatchObject({ p_pipeline: "fast-break-predictions", p_ok: true, p_rows_written: 1 })
  })

  it("never writes once the first game has tipped off", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-29T03:30:00Z"), toFake: ["Date"] })
    const s = slate(7)
    state.tables.fast_break_runs = { list: { data: [RUN], error: null } }
    state.tables.nba_games = { list: { data: [{ id: "g1", tipoff_at: "2026-11-29T03:00:00Z" }], error: null } }
    state.tables.nba_player_projections = { list: { data: s.proj, error: null } }
    state.tables.nba_players = { list: { data: s.meta, error: null } }
    state.tables.fast_break_nights = { single: { data: { objective: "x", targets: { pts: 110 } }, error: null } }
    await GET(req())
    expect(state.writes.filter(w => w.op === "upsert")).toHaveLength(0)
    expect(state.runs[0].p_extra.locked).toBe(1)
  })

  it("a failed read is a not-ok run with the error named — never a quiet green", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T17:00:00Z"), toFake: ["Date"] })
    state.tables.fast_break_runs = { list: { data: null, error: { message: "boom" } } }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(state.runs[0]).toMatchObject({ p_ok: false })
    expect(state.runs[0].p_error).toContain("runs_read: boom")
  })

  it("scores a past night whose game is final with box scores, and leaves an unfinished one alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T17:00:00Z"), toFake: ["Date"] })
    const picks = ["a", "b", "c", "d", "e"].map((id, i) => ({ id, name: id, team: "POR", gameId: "g0", captain: i === 0, bench: false }))
    state.tables.fast_break_predictions = {
      list: { data: [{ run_id: RUN.id, game_date: "2026-11-27", kind: "slate_best", targets: { pts: 100 }, players: picks }], error: null },
    }
    state.tables.nba_games = { list: { data: [{ id: "g0", status: "final" }], error: null } }
    state.tables.nba_player_game_stats = {
      list: { data: picks.map(p => ({ game_id: "g0", nba_player_id: p.id, did_play: true, pts: 20 })), error: null },
    }
    state.tables.fast_break_runs = { list: { data: [], error: null } }
    await GET(req())
    const upd = state.writes.filter(w => w.op === "update")
    expect(upd).toHaveLength(1)
    expect(upd[0].row).toMatchObject({ cleared: true, actual: { totals: { pts: 110 } } })

    state.writes = []
    state.tables.nba_games = { list: { data: [{ id: "g0", status: "scheduled" }], error: null } }
    await GET(req())
    expect(state.writes.filter(w => w.op === "update")).toHaveLength(0)
  })
})
