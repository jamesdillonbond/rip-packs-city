import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/player-stats-sync (batch 47,
// 2026-09-25) — the DB half of the ESPN stats feed; the runner script does the
// ESPN fetches. Seam: @supabase/supabase-js (heartbeat insert + the RPCs).
//
// Pinned honesty properties:
//   · the targets phase writes the -heartbeat row (a killed runner is then
//     read by correlation: heartbeat present, terminal row absent)
//   · a chunk's `upserted` is what the RPC RETURNED
//   · the final row's ok is DERIVED: every chunk landed AND no fetch/search
//     failed AND no deadline — problems named in the error; rows_written is
//     NULL when no chunk was ever sent (not measured), 404s go to rows_skipped
//   · an unknown league / phase / body shape is a 400, not a silent no-op

const state = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  inserts: [] as any[],
  rpcResult: {} as Record<string, { data: any; error: any }>,
}))

vi.mock("@supabase/supabase-js", () => {
  const sb: any = {}
  sb.from = () => ({ insert: async (row: any) => { state.inserts.push(row); return { error: null } } })
  sb.rpc = async (fn: string, args: any) => {
    state.rpcCalls.push({ fn, args })
    return state.rpcResult[fn] ?? { data: null, error: { message: "unexpected rpc " + fn } }
  }
  return { createClient: () => sb }
})

import { GET, POST } from "@/app/api/cron/player-stats-sync/route"

const url = "https://t/api/cron/player-stats-sync"
const AUTH = "Bearer test-ingest-secret"
const savedIngest = process.env.INGEST_SECRET_TOKEN

function terminal() {
  const t = state.rpcCalls.filter((c) => c.fn === "log_pipeline_run")
  expect(t.length, "exactly one terminal row").toBe(1)
  return t[0].args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  state.rpcCalls = []
  state.inserts = []
  state.rpcResult = {
    player_stats_sync_targets: { data: [{ identity_id: "i1", espn_id: "3139477", display_name: "Patrick Mahomes", stats_refreshed_at: null }], error: null },
    player_stats_espn_resolve_targets: { data: [{ identity_id: "i2", display_name: "Jimmy Butler III", name_slug: "jimmy-butler-iii" }], error: null },
    set_player_identity_espn_ids: { data: 1, error: null },
    upsert_player_season_stats: { data: 7, error: null },
    log_pipeline_run: { data: null, error: null },
  }
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("auth and validation", () => {
  it("401s without the bearer, writing nothing", async () => {
    expect((await GET(makeReq({ url: url + "?phase=targets&league=nfl", method: "GET" }))).status).toBe(401)
    expect((await POST(makeReq({ url, body: { league: "nfl", rows: [] } }))).status).toBe(401)
    expect(state.rpcCalls).toEqual([])
    expect(state.inserts).toEqual([])
  })
  it("400s an unknown league or phase", async () => {
    expect((await GET(makeReq({ url: url + "?phase=targets&league=mlb", method: "GET", auth: AUTH }))).status).toBe(400)
    expect((await GET(makeReq({ url: url + "?phase=nope&league=nfl", method: "GET", auth: AUTH }))).status).toBe(400)
    expect((await POST(makeReq({ url, auth: AUTH, body: { league: "nfl" } }))).status).toBe(400)
    expect((await POST(makeReq({ url, auth: AUTH, badJson: true }))).status).toBe(400)
    expect(state.rpcCalls.filter((c) => c.fn !== "log_pipeline_run")).toEqual([])
  })
})

describe("GET phases", () => {
  it("targets: writes the heartbeat FIRST, then returns the RPC's rows", async () => {
    const res = await GET(makeReq({ url: url + "?phase=targets&league=nfl&limit=50", method: "GET", auth: AUTH }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.targets[0].espn_id).toBe("3139477")
    expect(state.inserts[0].pipeline).toBe("player-stats-sync-heartbeat")
    expect(state.inserts[0].rows_written).toBeNull()
    expect(state.inserts[0].extra).toMatchObject({ league: "nfl", limit: 50 })
    const t = state.rpcCalls.find((c) => c.fn === "player_stats_sync_targets")!
    expect(t.args).toEqual({ p_league: "nfl", p_limit: 50 })
  })
  it("targets: a bad limit falls back to the default, never to 0", async () => {
    await GET(makeReq({ url: url + "?phase=targets&league=nba&limit=abc", method: "GET", auth: AUTH }))
    expect(state.rpcCalls.find((c) => c.fn === "player_stats_sync_targets")!.args.p_limit).toBe(300)
  })
  it("targets: an RPC failure is a 500 with the message, not an empty target list", async () => {
    state.rpcResult.player_stats_sync_targets = { data: null, error: { message: "canceling statement" } }
    const res = await GET(makeReq({ url: url + "?phase=targets&league=nfl", method: "GET", auth: AUTH }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/targets: canceling/)
  })
  it("the heartbeat carries the RUNNER's startedAt, so it correlates with the final row (±5 s) however long the runner worked first", async () => {
    const startedAt = new Date(Date.now() - 170_000).toISOString()
    await GET(makeReq({ url: url + `?phase=espn-resolve-targets&league=nba&startedAt=${encodeURIComponent(startedAt)}&hb=1`, method: "GET", auth: AUTH }))
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].pipeline).toBe("player-stats-sync-heartbeat")
    expect(state.inserts[0].started_at).toBe(startedAt)
    expect(state.inserts[0].extra).toMatchObject({ league: "nba", first_phase: "espn-resolve-targets" })
  })
  it("hb=0 on the run's second call writes NO second heartbeat (one marker per run)", async () => {
    const startedAt = new Date(Date.now() - 170_000).toISOString()
    await GET(makeReq({ url: url + `?phase=targets&league=nba&startedAt=${encodeURIComponent(startedAt)}&hb=0`, method: "GET", auth: AUTH }))
    expect(state.inserts).toEqual([])
  })
  it("an implausible startedAt (a day old, or in the future) falls back to now, not to the bogus instant", async () => {
    const before = Date.now()
    await GET(makeReq({ url: url + `?phase=targets&league=nfl&startedAt=${encodeURIComponent(new Date(before - 86_400_000).toISOString())}&hb=1`, method: "GET", auth: AUTH }))
    expect(Date.parse(state.inserts[0].started_at)).toBeGreaterThanOrEqual(before)
  })
  it("espn-resolve-targets: returns the unresolved identities, no heartbeat", async () => {
    const res = await GET(makeReq({ url: url + "?phase=espn-resolve-targets&league=nba", method: "GET", auth: AUTH }))
    expect(res.status).toBe(200)
    expect((await res.json()).targets[0].display_name).toBe("Jimmy Butler III")
    expect(state.inserts).toEqual([])
  })
})

describe("POST writes", () => {
  it("espn_ids: forwards to the RPC and reports its count", async () => {
    const res = await POST(makeReq({ url, auth: AUTH, body: { league: "nba", espn_ids: [{ identity_id: "i2", espn_id: "6430", matched_by: "espn-search:name" }] } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, updated: 1 })
    expect(state.rpcCalls[0]).toEqual({ fn: "set_player_identity_espn_ids", args: { p_league: "nba", p_rows: [{ identity_id: "i2", espn_id: "6430", matched_by: "espn-search:name" }] } })
  })
  it("rows: forwards rows + touched and reports what the RPC RETURNED (7), not what was sent (2)", async () => {
    const rows = [{ espn_id: "3139477", season: 2025, season_type: 2, category: "passing", labels: ["GP"], names: ["gp"], values: ["17"] }, { espn_id: "3139477", season: 2024, season_type: 2, category: "passing", labels: ["GP"], names: ["gp"], values: ["16"] }]
    const res = await POST(makeReq({ url, auth: AUTH, body: { league: "nfl", rows, touched: ["3139477", 5, "x"] } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, upserted: 7 })
    expect(state.rpcCalls[0].args).toEqual({ p_league: "nfl", p_rows: rows, p_touched: ["3139477", "x"] })
  })
  it("rows: an RPC failure is a 500 naming the upsert", async () => {
    state.rpcResult.upsert_player_season_stats = { data: null, error: { message: "boom" } }
    const res = await POST(makeReq({ url, auth: AUTH, body: { league: "nfl", rows: [], touched: [] } }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("upsert: boom")
  })
})

describe("POST final — ok is derived from the counts", () => {
  const good = { targets: 300, fetched_ok: 298, fetched_404: 2, fetched_failed: 0, rows_upserted: 4120, chunks: 8, chunks_ok: 8, resolve_targets: 0, resolved: 0, unresolved: 0, resolve_failed: 0, deadline_hit: false, errors: [], runner_event: "schedule" }

  it("a clean run logs ok:true with the counts in their columns", async () => {
    const res = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nfl", startedAt: "2026-09-25T23:40:00.000Z", stats: good } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, problems: [] })
    const t = terminal()
    expect(t.p_pipeline).toBe("player-stats-sync")
    expect(t.p_started_at).toBe("2026-09-25T23:40:00.000Z")
    expect(t.p_ok).toBe(true)
    expect(t.p_error).toBeNull()
    expect(t.p_rows_found).toBe(300)
    expect(t.p_rows_written).toBe(4120)
    expect(t.p_rows_skipped).toBe(2)
    expect(t.p_collection_slug).toBe("nfl_all_day")
    expect(t.p_extra).toMatchObject({ league: "nfl", source: "espn", fetched_ok: 298, chunks: 8, chunks_ok: 8, event: "schedule" })
  })

  it("a chunk that did not land, a failed fetch, a failed search and a deadline are each NAMED and make ok:false", async () => {
    const bad = { ...good, chunks_ok: 6, fetched_failed: 3, resolve_failed: 1, deadline_hit: true, errors: ["stats 1: HTTP 503"] }
    const res = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nba", stats: bad } }))
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.problems).toEqual([
      "2 of 8 chunks did not land",
      "3 ESPN stat fetches failed",
      "1 ESPN searches failed",
      "runner hit its deadline before finishing",
    ])
    const t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toMatch(/2 of 8 chunks did not land; 3 ESPN stat fetches failed/)
    expect(t.p_collection_slug).toBe("nba_top_shot")
    expect(t.p_extra.errors).toEqual(["stats 1: HTTP 503"])
    expect(t.p_extra.deadline_hit).toBe(true)
  })

  it("one ESPN 500 in 300 is NOTED, not a failed run — the player is retried next run; 5 % is", async () => {
    const one = { ...good, fetched_ok: 297, fetched_failed: 1 }
    const r1 = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nfl", stats: one } }))
    expect(await r1.json()).toEqual({ ok: true, problems: ["1 ESPN stat fetches failed"] })
    let t = terminal()
    expect(t.p_ok).toBe(true)
    expect(t.p_error).toBeNull()
    expect(t.p_extra.problems).toEqual(["1 ESPN stat fetches failed"])
    state.rpcCalls = []
    const many = { ...good, fetched_ok: 283, fetched_failed: 15 }
    const r2 = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nfl", stats: many } }))
    expect((await r2.json()).ok).toBe(false)
    t = terminal()
    expect(t.p_ok).toBe(false)
    expect(t.p_error).toBe("15 ESPN stat fetches failed")
  })

  it("one ESPN 504 in 400 name searches is NOTED, not a failed run — the target is retried next tick; 5 % is (batch 58)", async () => {
    const one = { ...good, resolve_targets: 400, resolved: 375, unresolved: 24, resolve_failed: 1 }
    const r1 = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nba", stats: one } }))
    expect(await r1.json()).toEqual({ ok: true, problems: ["1 ESPN searches failed"] })
    expect(terminal().p_ok).toBe(true)
    state.rpcCalls = []
    const many = { ...good, resolve_targets: 40, resolved: 30, unresolved: 6, resolve_failed: 4 }
    const r2 = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nba", stats: many } }))
    expect((await r2.json()).ok).toBe(false)
    expect(terminal().p_error).toBe("4 ESPN searches failed")
    state.rpcCalls = []
    // a search failure with NO targets counted (the targets read itself failed) is still a failed run
    const blind = { ...good, resolve_targets: 0, resolve_failed: 1 }
    const r3 = await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nba", stats: blind } }))
    expect((await r3.json()).ok).toBe(false)
  })

  it("a run that never sent a chunk logs rows_written NULL (not measured), never 0", async () => {
    const none = { ...good, targets: 0, fetched_ok: 0, fetched_404: 0, rows_upserted: 0, chunks: 0, chunks_ok: 0 }
    await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nfl", stats: none } }))
    const t = terminal()
    expect(t.p_ok).toBe(true)
    expect(t.p_rows_written).toBeNull()
    expect(t.p_rows_found).toBe(0)
  })

  it("missing counts are NULL in the row, not fabricated zeros", async () => {
    await POST(makeReq({ url, auth: AUTH, body: { final: true, league: "nfl", stats: {} } }))
    const t = terminal()
    expect(t.p_rows_found).toBeNull()
    expect(t.p_rows_written).toBeNull()
    expect(t.p_rows_skipped).toBeNull()
    expect(t.p_ok).toBe(true)
  })
})
