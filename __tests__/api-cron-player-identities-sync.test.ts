import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/player-identities-sync (2026-09-25,
// #139 follow-up). Seams: global fetch (nflverse players.csv) and
// @supabase/supabase-js (heartbeat insert, the two RPCs, log_pipeline_run).
//
// The honesty properties this pins:
//   · a failed fetch / a changed header logs ok:false WITH the error and
//     rows_written NULL (not measured) — never a 200 with zero rows
//   · rows_written is the SUM THE RPC RETURNED, not the rows sent
//   · a chunk that fails stops the run, logs the partial sum, ok:false
//   · ok is true only when every chunk landed AND the match succeeded
//   · the heartbeat lands BEFORE the fetch (a kill is then read by correlation)

const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  inserts: [] as any[],
  upsertReturn: (rows: any[]) => rows.length,
  upsertFailAtChunk: -1,
  matchResult: { data: { league: "nfl", matched: { name: 3 } } as any, error: null as any },
}))

vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  sb.from = () => ({ insert: async (row: any) => { state.inserts.push(row); return { error: null } } })
  sb.rpc = async (fn: string, args: any) => {
    state.rpcCalls.push({ fn, args })
    if (fn === "upsert_player_identities") {
      const n = state.rpcCalls.filter((c) => c.fn === fn).length - 1
      if (n === state.upsertFailAtChunk) return { data: null, error: { message: "boom on chunk " + n } }
      return { data: state.upsertReturn(args.p_rows), error: null }
    }
    if (fn === "match_player_identities") return state.matchResult
    if (fn === "log_pipeline_run") return { data: null, error: null }
    return { data: null, error: { message: "unexpected rpc " + fn } }
  }
  return { createClient: () => sb }
})

import { POST } from "@/app/api/cron/player-identities-sync/route"

const url = "https://t/api/cron/player-identities-sync"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const HEADER = "gsis_id,display_name,first_name,last_name,birth_date,position,latest_team,rookie_season,last_season,status,espn_id,pfr_id,nfl_id,headshot"

function csvOf(n: number): string {
  const lines = [HEADER]
  for (let i = 0; i < n; i++) lines.push(`00-${String(i).padStart(7, "0")},Player ${i},P,${i},2000-01-01,QB,BUF,2020,2026,ACT,${1000 + i},,,`)
  return lines.join("\n") + "\n"
}

function stubFetch(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body })))
}

function terminal() {
  const t = state.rpcCalls.filter((c) => c.fn === "log_pipeline_run")
  expect(t.length, "exactly one terminal row").toBe(1)
  return t[0].args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  state.rpcCalls = []
  state.inserts = []
  state.upsertReturn = (rows) => rows.length
  state.upsertFailAtChunk = -1
  state.matchResult = { data: { league: "nfl", matched: { name: 3 } }, error: null }
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("auth and league", () => {
  it("401s without the bearer and writes NOTHING", async () => {
    stubFetch(200, csvOf(1))
    expect((await POST(makeReq({ url }))).status).toBe(401)
    expect(state.rpcCalls).toEqual([])
    expect(state.inserts).toEqual([])
  })

  it("400s ?league=nba rather than faking a feed", async () => {
    stubFetch(200, csvOf(1))
    const res = await POST(makeReq({ url: url + "?league=nba", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(400)
    expect(state.rpcCalls).toEqual([])
  })
})

describe("the happy path", () => {
  it("chunks the upsert, sums what the RPC RETURNED, matches, logs ok:true", async () => {
    stubFetch(200, csvOf(1203))
    // the RPC reports fewer than sent (one chunk had 3 unusable rows): the log must carry ITS number
    state.upsertReturn = (rows) => (rows.length === 500 ? 497 : rows.length)
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.chunks).toBe(3)
    expect(body.chunks_ok).toBe(3)
    expect(body.rows_upserted).toBe(497 + 497 + 203)
    expect(body.source_rows).toBe(1203)

    const ups = state.rpcCalls.filter((c) => c.fn === "upsert_player_identities")
    expect(ups.map((c) => c.args.p_rows.length)).toEqual([500, 500, 203])
    expect(ups[0].args.p_league).toBe("nfl")
    expect(ups[0].args.p_source).toBe("nflverse")
    expect(ups[0].args.p_rows[0]).toMatchObject({ league_player_id: "00-0000000", display_name: "Player 0", espn_id: "1000", nfl_id: null })

    const t = terminal()
    expect(t.p_pipeline).toBe("player-identities-sync")
    expect(t.p_ok).toBe(true)
    expect(t.p_error).toBeNull()
    expect(t.p_rows_found).toBe(1203)
    expect(t.p_rows_written).toBe(1197)
    expect(t.p_extra.match).toEqual({ league: "nfl", matched: { name: 3 } })
    expect(t.p_extra.chunks_ok).toBe(3)
  })

  it("writes the heartbeat BEFORE the fetch, under the -heartbeat name", async () => {
    const order: string[] = []
    vi.stubGlobal("fetch", vi.fn(async () => { order.push("fetch"); return { ok: true, status: 200, text: async () => csvOf(2) } }))
    const origFrom = state.inserts
    state.inserts = new Proxy(origFrom, { set(t, k, v) { if (k !== "length") order.push("heartbeat"); return Reflect.set(t, k, v) } })
    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(order.slice(0, 2)).toEqual(["heartbeat", "fetch"])
    expect(state.inserts[0].pipeline).toBe("player-identities-sync-heartbeat")
    expect(state.inserts[0].rows_written).toBeNull()
  })
})

describe("failures are logged as failures, never as zero rows", () => {
  it("a non-200 from nflverse: 500, ok:false, the status in the error, rows_written NULL", async () => {
    stubFetch(503, "unavailable")
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toMatch(/HTTP 503/)
    expect(t.p_rows_written).toBeNull()
    expect(t.p_rows_found).toBeNull()
    expect(state.rpcCalls.filter((c) => c.fn === "upsert_player_identities")).toEqual([])
  })

  it("a fetch that throws (timeout) is the error string, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("The operation was aborted due to timeout") }))
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    expect(terminal().p_error).toMatch(/timeout/)
  })

  it("a changed upstream header is a FAILED read (throws inside), logged with the reason", async () => {
    stubFetch(200, "player_id,name\n1,x\n")
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toMatch(/header lacks "gsis_id"/)
    expect(t.p_rows_written).toBeNull()
  })

  it("a header-only file (zero usable rows) is refused as a broken source", async () => {
    stubFetch(200, HEADER + "\n")
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    expect(terminal().p_error).toMatch(/zero usable rows/)
  })

  it("a chunk that fails STOPS the run: partial sum logged, ok:false, no match attempted", async () => {
    stubFetch(200, csvOf(1100))
    state.upsertFailAtChunk = 1
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.chunks).toBe(3)
    expect(body.chunks_ok).toBe(1)
    expect(body.rows_upserted).toBe(500)
    const t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toMatch(/upsert_player_identities: boom on chunk 1/)
    expect(t.p_rows_written).toBe(500)
    expect(state.rpcCalls.filter((c) => c.fn === "match_player_identities")).toEqual([])
  })

  it("a failed match after a full upsert is ok:false with the rows that DID land", async () => {
    stubFetch(200, csvOf(10))
    state.matchResult = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(500)
    const t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toMatch(/match_player_identities: canceling/)
    expect(t.p_rows_written).toBe(10)
  })
})
