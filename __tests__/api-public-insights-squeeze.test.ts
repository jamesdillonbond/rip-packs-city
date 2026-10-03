import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/squeeze. Thin wrapper over the
// topshot_squeeze_board view via a chained supabaseAdmin query builder. Pins the
// param guards (invalid tier / negative min_squeeze / invalid sort → 400 pre-DB)
// plus the happy and rpc-error paths through a thenable mock builder.

const state: { data: any; error: any; rpc: any; rpcError: any; calls: { fn: string; args: unknown[] }[] } = { data: [], error: null, rpc: null, rpcError: null, calls: [] }

vi.mock("@/lib/supabase", () => {
  const rec = (fn: string) => (...args: unknown[]) => { state.calls.push({ fn, args }); return b }
  const b: any = {
    select: rec("select"),
    eq: rec("eq"),
    gte: rec("gte"),
    lte: rec("lte"),
    in: rec("in"),
    ilike: rec("ilike"),
    order: rec("order"),
    limit: rec("limit"),
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b, rpc: (name: string, args: unknown) => { state.calls.push({ fn: `rpc:${name}`, args: [args] }); return Promise.resolve({ data: state.rpc, error: state.rpcError }) } } }
})

import { GET } from "@/app/api/public/insights/squeeze/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/squeeze"

beforeEach(() => {
  state.data = []
  state.error = null
  state.rpc = null
  state.rpcError = null
  state.calls = []
})

describe("GET /api/public/insights/squeeze", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${BASE}?tier=BOGUS`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("400s on a negative min_squeeze", async () => {
    const res = await GET(req(`${BASE}?min_squeeze=-5`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("min_squeeze must be a non-negative")
  })

  it("accepts sort=concentration (beta feedback 10256)", async () => {
    const res = await GET(req(`${BASE}?sort=concentration`))
    expect(res.status).toBe(200)
    expect(state.calls.find((c) => c.fn === "order")?.args).toEqual(["top5_share_pct", { ascending: false, nullsFirst: false }])
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${BASE}?sort=nope`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns board rows on the happy path", async () => {
    state.data = [{ edition_id: "e1", squeeze_pct: 81, player_name: "Wemby" }]
    const res = await GET(req(`${BASE}?tier=RARE&sort=squeeze&limit=10`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_squeeze_board")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  // 2026-10-03 (beta feedback 10250 / 10252 / 10253): floors under the 1/1s,
  // and a team filter that is the FRANCHISE, not the typed label.
  it("400s on a negative floor", async () => {
    expect((await GET(req(`${BASE}?min_circulation=-1`))).status).toBe(400)
    expect((await GET(req(`${BASE}?min_buyable=-1`))).status).toBe(400)
    expect(state.calls.filter((c) => c.fn === "select")).toHaveLength(0) // pre-DB
  })

  it("passes the floors to the query and echoes them in meta.filters", async () => {
    const res = await GET(req(`${BASE}?min_circulation=500&min_buyable=50`))
    expect(res.status).toBe(200)
    const gtes = state.calls.filter((c) => c.fn === "gte").map((c) => c.args)
    expect(gtes).toEqual([["squeeze_pct", 50], ["circulation", 500], ["effectively_buyable", 50]])
    const body = await res.json()
    expect(body.meta.filters.min_circulation).toBe(500)
    expect(body.meta.filters.min_buyable).toBe(50)
    expect(body.meta.filters.team).toBeNull()
  })

  it("resolves ?team= to the franchise's every label and filters on the LIST, never the typed text", async () => {
    state.rpc = { status: "one", current_name: "LA Clippers", names: [{ team_name: "LA Clippers" }, { team_name: "Los Angeles Clippers" }, { team_name: "Buffalo Braves" }] }
    state.data = [{ edition_id: "e1", squeeze_pct: 70, player_name: "Kawhi", team_name: "Los Angeles Clippers" }]
    const res = await GET(req(`${BASE}?team=clippers`))
    expect(res.status).toBe(200)
    expect(state.calls.find((c) => c.fn === "rpc:resolve_team_name")?.args[0]).toMatchObject({ p_name: "clippers" })
    expect(state.calls.find((c) => c.fn === "in")?.args).toEqual(["team_name", ["LA Clippers", "Los Angeles Clippers", "Buffalo Braves"]])
    expect(state.calls.some((c) => c.fn === "ilike" && c.args[0] === "team_name")).toBe(false)
    const body = await res.json()
    expect(body.meta.filters.team_resolution).toEqual({ status: "one", current_name: "LA Clippers", labels: 3 })
    expect(body.rows).toHaveLength(1)
  })

  it("a team nothing matches answers an EMPTY board (in(team_name, [])), never the unfiltered one", async () => {
    state.rpc = { status: "none" }
    const res = await GET(req(`${BASE}?team=zzzz`))
    expect(res.status).toBe(200)
    expect(state.calls.find((c) => c.fn === "in")?.args).toEqual(["team_name", []])
    expect((await res.json()).meta.filters.team_resolution).toEqual({ status: "none", current_name: null, labels: 0 })
  })

  it("a failed team resolution is a failed read (503-class), not an unfiltered board under a team heading", async () => {
    state.rpcError = { message: "canceling statement due to statement timeout" }
    const res = await GET(req(`${BASE}?team=clippers`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(state.calls.some((c) => c.fn === "select")).toBe(false)
    expect((await res.json()).error).not.toContain("canceling")
  })

  it("500s on a query error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("boom")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
