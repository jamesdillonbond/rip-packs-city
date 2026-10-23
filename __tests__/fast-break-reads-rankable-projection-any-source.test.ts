import { describe, it, expect, beforeEach, vi } from "vitest"

// known-issues #8, 2026-10-23. The free ESPN lane (`nba-espn-projections`, a
// pg_net DB lane) writes nba_games + nba_player_projections with
// source = 'espn'. Both Fast Break reads pinned `source = 'draftkings'` and the
// feed-freshness check named only `sync-nba-projections`, so with the ESPN data
// LIVE every game night still rendered "projections unavailable" and an empty
// slate still read as our outage. These pins hold the fix:
//   1. neither route filters projections by source — they ask for the RANKABLE
//      row (proj_fp_dk NOT NULL), which the DB guarantees is one per player per
//      date (trigger nba_projection_single_rankable);
//   2. the feed check accepts the ESPN lane as an nba_games writer.
// The mock RECORDS each filter call, so the assertions are about the query the
// route actually built, not about rows a permissive mock happened to return.

type Call = { table: string; method: string; args: unknown[] }
const calls: Call[] = []
const state: { tables: Record<string, any> } = { tables: {} }

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "not", "order", "gt", "gte", "lt", "limit"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return b
      }
    }
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async () => ({ data: [], error: null }),
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { POST } from "@/app/api/fast-break/optimize/route"
import { GET } from "@/app/api/fast-break/today/route"
import { NBA_FEED_PIPELINES, nbaFeedAnsweredRecently } from "@/lib/fast-break/nba-feed"

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date())
const RUN = {
  id: "11111111-1111-4111-8111-111111111111", name: "Run", start_date: today, end_date: today,
  lineup_size: 2, has_captain: true, objective: "max_points", is_active: true,
}

const projectionFilters = () => calls.filter(c => c.table === "nba_player_projections")

beforeEach(() => {
  calls.length = 0
  state.tables = {
    fast_break_runs: { single: { data: RUN, error: null } },
    nba_games: { list: { data: [{ id: "g1", home_team_abbr: "LAL", away_team_abbr: "LAC", tipoff_at: "t", status: "scheduled" }], error: null } },
    nba_player_projections: { list: { data: [], error: null } },
  }
})

describe("Fast Break reads the rankable projection from ANY source (#8)", () => {
  it("/api/fast-break/optimize does not pin source = 'draftkings' and asks for proj_fp_dk NOT NULL", async () => {
    const req = {
      headers: new Headers(),
      nextUrl: new URL("https://t/api/fast-break/optimize"),
      json: async () => ({ walletAddr: "0xabcdef0123456789", runId: RUN.id }),
    } as any
    await POST(req)
    const f = projectionFilters()
    expect(f.length, "the route must have queried projections at all").toBeGreaterThan(0)
    expect(f.some(c => c.method === "eq" && c.args[0] === "source")).toBe(false)
    expect(f.some(c => c.method === "not" && c.args[0] === "proj_fp_dk" && c.args[1] === "is" && c.args[2] === null)).toBe(true)
  })

  it("/api/fast-break/today does not pin source = 'draftkings' and asks for proj_fp_dk NOT NULL", async () => {
    await GET()
    const f = projectionFilters()
    expect(f.length, "the route must have queried projections at all").toBeGreaterThan(0)
    expect(f.some(c => c.method === "eq" && c.args[0] === "source")).toBe(false)
    expect(f.some(c => c.method === "not" && c.args[0] === "proj_fp_dk" && c.args[1] === "is" && c.args[2] === null)).toBe(true)
  })
})

describe("the feed check accepts the ESPN lane as an nba_games writer (#8)", () => {
  it("lists both writers, the ESPN lane included", () => {
    expect(NBA_FEED_PIPELINES).toContain("nba-espn-projections")
    expect(NBA_FEED_PIPELINES).toContain("sync-nba-projections")
  })

  it("queries pipeline_runs with .in() over every writer, not .eq() on one", async () => {
    state.tables.pipeline_runs = { list: { data: null, count: 1, error: null } }
    const db = (await import("@/lib/supabase")).supabaseAdmin
    const fresh = await nbaFeedAnsweredRecently(db, "[test]")
    expect(fresh).toBe(true)
    const runs = calls.filter(c => c.table === "pipeline_runs")
    const inCall = runs.find(c => c.method === "in" && c.args[0] === "pipeline")
    expect(inCall, "pipeline must be matched with .in()").toBeTruthy()
    expect(inCall!.args[1]).toEqual(expect.arrayContaining(["nba-espn-projections", "sync-nba-projections"]))
    expect(runs.some(c => c.method === "eq" && c.args[0] === "pipeline")).toBe(false)
  })
})
