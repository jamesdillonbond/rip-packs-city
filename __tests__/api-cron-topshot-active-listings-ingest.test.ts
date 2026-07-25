import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"

// Route-integration test for /api/cron/topshot-active-listings-ingest.
// Auth: authed(req) accepts Bearer INGEST_SECRET_TOKEN or CRON_SECRET (env-gated,
// fail-closed). GET additionally validates ?phase and ?floor BEFORE any DB call.
// Asserts: fail-closed auth on GET+POST, and the two param-400s on GET which are
// reachable with valid auth without touching Supabase.
//
// SUCCESS PATH: GET ?phase=targets AWAITS supabaseAdmin.rpc("topshot_serial_
// board_targets") on the synchronous path and returns 200 {floor, count, targets}.
// POST with no rows/deactivate/final returns 200 {ok, upserted:0, deactivated:0}
// without any rpc. supabaseAdmin is stubbed so the targets rpc returns a fixed
// list and we assert count/floor derived from it.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

const TARGETS_FIXTURE = [
  { rpc_edition_id: "e1", external_id: "1:1", atlas_edition_id: "a1" },
  { rpc_edition_id: "e2", external_id: "2:2", atlas_edition_id: "a2" },
  { rpc_edition_id: "e3", external_id: "3:3", atlas_edition_id: "a3" },
]
const st = vi.hoisted(() => ({
  results: {} as Record<string, { data: any; error: any }>,
  calls: [] as Array<{ name: string; args: any }>,
  logThrows: false,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      st.calls.push({ name, args })
      if (name === "log_pipeline_run" && st.logThrows) throw new Error("log down")
      return st.results[name] ?? { data: TARGETS_FIXTURE, error: null }
    },
  },
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-active-listings-ingest/route")
})

const OK = "Bearer test-ingest-token"

describe("/api/cron/topshot-active-listings-ingest", () => {
  it("GET 401s without authorization", async () => {
    expect((await mod.GET(makeReq({ method: "GET" }))).status).toBe(401)
  })

  it("POST 401s with a wrong bearer token", async () => {
    expect((await mod.POST(makeReq({ auth: "Bearer nope" }))).status).toBe(401)
  })

  it("GET 400s on an unknown phase (authed, pre-DB)", async () => {
    const res = await mod.GET(makeReq({ method: "GET", url: "https://t/api/cron/x", auth: OK }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown phase")
  })

  it("GET 400s on a bad floor value (authed, pre-DB)", async () => {
    const res = await mod.GET(
      makeReq({ method: "GET", url: "https://t/api/cron/x?phase=targets&floor=-5", auth: OK }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("bad floor")
  })
})

describe("/api/cron/topshot-active-listings-ingest — success path", () => {
  it("GET ?phase=targets 200s with floor/count/targets from the board rpc", async () => {
    const res = await mod.GET(
      makeReq({ method: "GET", url: "https://t/api/cron/x?phase=targets", auth: OK }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.floor).toBe(100) // DEFAULT_FLOOR when ?floor omitted
    expect(body.count).toBe(TARGETS_FIXTURE.length)
    expect(body.targets).toHaveLength(TARGETS_FIXTURE.length)
  })

  it("GET honors an explicit ?floor override", async () => {
    const res = await mod.GET(
      makeReq({ method: "GET", url: "https://t/api/cron/x?phase=targets&floor=250", auth: OK }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).floor).toBe(250)
  })

  it("POST with an empty body 200s the no-op accept (no rows, no deactivate)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: OK, body: {} }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(0)
    expect(body.deactivated).toBe(0)
  })
})

// --- the ingest POST: upsert, deactivation, and the WAF-blocked safety rule ---

const post = (body: any) =>
  ({
    headers: new Headers({ authorization: "Bearer test-ingest-token" }),
    nextUrl: new URL("https://t/api/cron/topshot-active-listings-ingest"),
    json: async () => body,
  }) as any

function logRow() {
  return st.calls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

describe("topshot-active-listings-ingest — GET failure + POST ingest", () => {
  beforeEach(() => {
    st.results = {}
    st.calls = []
    st.logThrows = false
  })

  it("GET 500s when the targets RPC errors", async () => {
    st.results.topshot_serial_board_targets = { data: null, error: { message: "targets down" } }
    const res = await mod.GET(makeReq({
      url: "https://t/api/cron/topshot-active-listings-ingest?phase=targets",
      method: "GET", auth: "Bearer test-ingest-token",
    }))
    expect(res.status).toBe(500)
  })

  it("POST 400s on malformed JSON", async () => {
    const res = await mod.POST({
      headers: new Headers({ authorization: "Bearer test-ingest-token" }),
      nextUrl: new URL("https://t/api/cron/topshot-active-listings-ingest"),
      json: async () => { throw new Error("bad") },
    } as any)
    expect(res.status).toBe(400)
  })

  it("upserts the submitted rows and reports the count", async () => {
    st.results.upsert_topshot_active_listings = { data: 42, error: null }
    const body = await (await mod.POST(post({ rows: [{ a: 1 }, { a: 2 }] }))).json()
    expect(body).toMatchObject({ ok: true, upserted: 42, deactivated: 0 })
  })

  it("500s when the upsert RPC errors", async () => {
    st.results.upsert_topshot_active_listings = { data: null, error: { message: "upsert down" } }
    const res = await mod.POST(post({ rows: [{ a: 1 }] }))
    expect(res.status).toBe(500)
    expect(String((await res.json()).error)).toContain("upsert:")
  })

  it("deactivates stale listings only when the runner asks", async () => {
    st.results.deactivate_stale_topshot_active_listings = { data: 7, error: null }
    const body = await (await mod.POST(post({ deactivate: true, stats: {} }))).json()
    expect(body.deactivated).toBe(7)
    expect(st.calls.some((c) => c.name === "deactivate_stale_topshot_active_listings")).toBe(true)
  })

  it("500s when the deactivate RPC errors", async () => {
    st.results.deactivate_stale_topshot_active_listings = { data: null, error: { message: "deact down" } }
    const res = await mod.POST(post({ deactivate: true }))
    expect(res.status).toBe(500)
    expect(String((await res.json()).error)).toContain("deactivate:")
  })

  it("SAFETY: a WAF-blocked sweep LOGS ok:false but must NOT deactivate", async () => {
    // The runner sends final:true (terminal) with ok:false and NO deactivate,
    // precisely so a blocked-egress sweep can't empty the board.
    const body = await (await mod.POST(post({
      final: true, ok: false, error: "egress blocked",
      stats: { listings_found: 0, rows_upserted: 0, targets_skipped: 12 },
    }))).json()
    expect(body.deactivated).toBe(0)
    expect(st.calls.some((c) => c.name === "deactivate_stale_topshot_active_listings")).toBe(false)
    const log = logRow()
    expect(log.p_ok).toBe(false)
    expect(log.p_error).toBe("egress blocked")
    expect(log.p_rows_skipped).toBe(12)
  })

  it("logs the runner's cumulative stats on a healthy terminal sweep", async () => {
    st.results.deactivate_stale_topshot_active_listings = { data: 3, error: null }
    await mod.POST(post({
      final: true, deactivate: true, floor: 250, startedAt: "2026-07-25T00:00:00Z",
      stats: { listings_found: 100, rows_upserted: 90, targets_skipped: 2 },
    }))
    const log = logRow()
    expect(log).toMatchObject({
      p_pipeline: "topshot-active-listings-ingest",
      p_ok: true,
      p_rows_found: 100,
      p_rows_written: 90,
      p_collection_slug: "nba_top_shot",
      p_started_at: "2026-07-25T00:00:00Z",
    })
    expect(log.p_extra).toMatchObject({ deactivated: 3, floor: 250 })
  })

  it("does NOT log on a mid-sweep POST (neither final nor deactivate)", async () => {
    st.results.upsert_topshot_active_listings = { data: 5, error: null }
    await mod.POST(post({ rows: [{ a: 1 }] }))
    expect(st.calls.some((c) => c.name === "log_pipeline_run")).toBe(false)
  })

  it("swallows a log_pipeline_run failure and still returns 200", async () => {
    st.logThrows = true
    const res = await mod.POST(post({ final: true, stats: {} }))
    expect(res.status).toBe(200)
  })
})
