import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/fast-break/tonight — regular-season Fast Break (nightly stat targets).
// Pins the three-states rule: a FAILED read is a named 500, a missing night is
// `targets_unknown` (never "no targets"), and only a fully answered read builds a lineup.

const state: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "not", "order", "gt", "gte", "lt", "limit"]) b[m] = () => b
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

vi.mock("@/lib/fast-break/nba-feed", () => ({ nbaFeedAnsweredRecently: async () => true }))

import { POST } from "@/app/api/fast-break/tonight/route"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WALLET = "0xabcdef0123456789"
const DATE = "2026-11-27"

const req = (body: any, opts: { bad?: boolean } = {}) =>
  ({
    headers: new Headers(),
    json: async () => {
      if (opts.bad) throw new Error("bad json")
      return body
    },
  }) as any

const RUN = {
  id: RUN_ID, name: "Classic Run — Nov 16–29", lineup_size: 5, has_captain: true,
  start_date: "2026-11-16", end_date: "2026-11-29", objective: "thresholds",
}

function slate(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
  return {
    eligible: ids.map((id, i) => ({
      nba_player_id: id, full_name: `Player ${i}`, current_team_abbr: "POR", highest_tier: "RARE",
      total_allowed: 2, remaining_uses: 2, best_moment_id: `m${i}`, best_serial: 10 + i,
    })),
    proj: ids.map((id, i) => ({
      nba_player_id: id, game_id: "g1", injury_status: "ACTIVE", proj_threes: 3 + i * 0.1, proj_three_attempts: 8,
    })),
  }
}

beforeEach(() => {
  state.tables = {}
  state.rpc = {}
})

describe("POST /api/fast-break/tonight", () => {
  it("400s on malformed JSON and on a bad wallet", async () => {
    expect((await POST(req(null, { bad: true }))).status).toBe(400)
    expect((await POST(req({ walletAddr: "nope", runId: RUN_ID }))).status).toBe(400)
  })

  it("404s when the run is not found", async () => {
    const res = await POST(req({ walletAddr: WALLET, runId: RUN_ID, gameDate: DATE }))
    expect(res.status).toBe(404)
  })

  it("500s with a named error when the targets read fails — never 'no targets'", async () => {
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.fast_break_nights = { single: { data: null, error: { message: "boom" } } }
    const res = await POST(req({ walletAddr: WALLET, runId: RUN_ID, gameDate: DATE }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("targets_lookup_failed")
  })

  it("500s when the eligibility read fails rather than reporting an empty roster", async () => {
    const s = slate(6)
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.fast_break_nights = { single: { data: { objective: "x", targets: { fg3m: 18 } }, error: null } }
    state.tables.nba_games = { list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL" }], error: null } }
    state.tables.nba_player_projections = { list: { data: s.proj, error: null } }
    state.rpc.get_fb_eligible_players_v2 = { data: null, error: { message: "boom" } }
    const res = await POST(req({ walletAddr: WALLET, runId: RUN_ID, gameDate: DATE }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("eligible_rpc_failed")
  })

  it("says targets_unknown (no lineup) when tonight has games but no recorded targets", async () => {
    const s = slate(6)
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.fast_break_nights = { single: { data: null, error: null } }
    state.tables.nba_games = { list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL" }], error: null } }
    state.tables.nba_player_projections = { list: { data: s.proj, error: null } }
    state.rpc.get_fb_eligible_players_v2 = { data: s.eligible, error: null }
    const body = await (await POST(req({ walletAddr: WALLET, runId: RUN_ID, gameDate: DATE }))).json()
    expect(body.dataStatus).toBe("targets_unknown")
    expect(body.lineup).toBeNull()
  })

  it("builds five players plus Captain and a bench pick when every read answers", async () => {
    const s = slate(7)
    state.tables.fast_break_runs = { single: { data: RUN, error: null } }
    state.tables.fast_break_nights = {
      single: { data: { objective: "Combine for 18 3-Pointers Made + 40 3-Pointers Attempted", targets: { fg3m: 18, fg3a: 40 } }, error: null },
    }
    state.tables.nba_games = { list: { data: [{ id: "g1", home_team_abbr: "POR", away_team_abbr: "LAL" }], error: null } }
    state.tables.nba_player_projections = { list: { data: s.proj, error: null } }
    state.rpc.get_fb_eligible_players_v2 = { data: s.eligible, error: null }
    const body = await (await POST(req({ walletAddr: WALLET, runId: RUN_ID, gameDate: DATE }))).json()
    expect(body.dataStatus).toBe("ok")
    expect(body.lineup.players).toHaveLength(5)
    expect(body.lineup.captainNbaPlayerId).toBeTruthy()
    expect(body.lineup.bench).toBeTruthy()
    expect(body.lineup.targets.map((t: any) => t.stat).sort()).toEqual(["fg3a", "fg3m"])
    expect(body.lineup.winProbability).toBeGreaterThan(0)
  })
})
