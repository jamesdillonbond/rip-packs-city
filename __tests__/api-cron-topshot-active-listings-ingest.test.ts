import { describe, it, expect, beforeAll } from "vitest"

// Route-integration test for /api/cron/topshot-active-listings-ingest.
// Auth: authed(req) accepts Bearer INGEST_SECRET_TOKEN or CRON_SECRET (env-gated,
// fail-closed). GET additionally validates ?phase and ?floor BEFORE any DB call.
// Asserts: fail-closed auth on GET+POST, and the two param-400s on GET which are
// reachable with valid auth without touching Supabase.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

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
