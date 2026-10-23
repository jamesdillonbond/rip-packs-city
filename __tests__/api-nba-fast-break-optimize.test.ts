import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/nba/fast-break/optimize (public).
// When no run_id is given the handler looks up the active fast_break_runs row,
// then calls optimize_fast_break_lineup(run_id, game_date). Pins: the
// no-active-run empty-lineup 200, the run-lookup 500, and the rpc happy path
// (run_id supplied → skips the lookup).

const state: { run: any; runErr: any; rpc: any; rpcErr: any; feedCount: number | null; feedErr: any } = {
  run: null,
  runErr: null,
  rpc: null,
  rpcErr: null,
  feedCount: 0,
  feedErr: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    in: () => b,
    order: () => b,
    limit: () => b,
    gte: () => b,
    maybeSingle: async () => ({ data: state.run, error: state.runErr }),
    // pipeline_runs head-count (lib/fast-break/nba-feed.ts)
    then: (f: any, g: any) => Promise.resolve({ data: null, count: state.feedCount, error: state.feedErr }).then(f, g),
  }
  return {
    supabaseAdmin: {
      from: () => b,
      rpc: async () => ({ data: state.rpc, error: state.rpcErr }),
    },
  }
})

import { GET } from "@/app/api/nba/fast-break/optimize/route"

const req = (url: string) => ({ url }) as any

beforeEach(() => {
  state.run = null
  state.runErr = null
  state.rpc = null
  state.rpcErr = null
  state.feedCount = 0
  state.feedErr = null
})

describe("GET /api/nba/fast-break/optimize", () => {
  it("returns an empty lineup with no_active_run when there is no active run", async () => {
    state.run = null
    const res = await GET(req("https://t/api/nba/fast-break/optimize"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lineup).toEqual([])
    expect(body.meta.no_active_run).toBe(true)
  })

  it("500s when the run lookup errors", async () => {
    state.runErr = { message: "run query failed" }
    const res = await GET(req("https://t/api/nba/fast-break/optimize"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("run query failed")
  })

  it("returns the optimizer payload when run_id is supplied", async () => {
    state.rpc = { recommended_score: 42, lineup: [{ player: "x" }] }
    const res = await GET(req("https://t/api/nba/fast-break/optimize?run_id=r1&game_date=2026-05-11"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.recommended_score).toBe(42)
    expect(body.lineup).toHaveLength(1)
    expect(typeof body.as_of).toBe("string")
  })

  // ⚠ 2026-10-18: nba_games and the projections have had no working writer since 08-04 (#8), and
  // the client rendered every empty lineup as "No NBA games on <date>".
  it("an empty lineup with a DEAD feed is data_status feed_unavailable", async () => {
    state.rpc = { recommended_score: 0, lineup: [] }
    state.feedCount = 0
    const body = await (await GET(req("https://t/api/nba/fast-break/optimize?run_id=r1&game_date=2026-10-22"))).json()
    expect(body.data_status).toBe("feed_unavailable")
  })

  it("an empty lineup with an unreadable feed check is feed_unavailable too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    state.rpc = { recommended_score: 0, lineup: [] }
    state.feedCount = null
    state.feedErr = { message: "timeout" }
    const body = await (await GET(req("https://t/api/nba/fast-break/optimize?run_id=r1&game_date=2026-10-22"))).json()
    expect(body.data_status).toBe("feed_unavailable")
  })

  it("an empty lineup with a LIVE feed is ok (a real night off)", async () => {
    state.rpc = { recommended_score: 0, lineup: [] }
    state.feedCount = 3
    const body = await (await GET(req("https://t/api/nba/fast-break/optimize?run_id=r1&game_date=2026-10-22"))).json()
    expect(body.data_status).toBe("ok")
  })

  it("CONTROL — a lineup is ok even with the feed dead", async () => {
    state.rpc = { recommended_score: 42, lineup: [{ player: "x" }] }
    state.feedCount = 0
    const body = await (await GET(req("https://t/api/nba/fast-break/optimize?run_id=r1&game_date=2026-10-22"))).json()
    expect(body.data_status).toBe("ok")
  })
})
