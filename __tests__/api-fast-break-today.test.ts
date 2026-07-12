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
})
