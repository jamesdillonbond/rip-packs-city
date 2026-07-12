import { describe, it, expect, beforeAll, vi } from "vitest"

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
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: TARGETS_FIXTURE, error: null }) },
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
