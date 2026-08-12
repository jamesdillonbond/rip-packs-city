import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/nba/fast-break/optimize (public).
// When no run_id is given the handler looks up the active fast_break_runs row,
// then calls optimize_fast_break_lineup(run_id, game_date). Pins: the
// no-active-run empty-lineup 200, the run-lookup 500, and the rpc happy path
// (run_id supplied → skips the lookup).

const state: { run: any; runErr: any; rpc: any; rpcErr: any } = {
  run: null,
  runErr: null,
  rpc: null,
  rpcErr: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: state.run, error: state.runErr }),
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
})
