import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/sync-topshot-ownership-dune.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the route is INERT until DUNE_PROXY_URL + DUNE_PROXY_SECRET +
// DUNE_OWNERSHIP_QUERY_ID are all set — an authed run with those unset returns
// 202 {ok, skipped:"dune_not_configured"} WITHOUT any Dune I/O (the heavy walk is
// after()-deferred and never reached). We assert that honest-skip accept. The
// log_pipeline_run rpc is fired in a try/catch; supabaseAdmin is stubbed inert so
// no real network is attempted. The Dune env vars are cleared before import so the
// skip branch is taken deterministically regardless of ambient environment.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"
delete process.env.DUNE_PROXY_URL
delete process.env.DUNE_PROXY_SECRET
delete process.env.DUNE_OWNERSHIP_QUERY_ID

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/sync-topshot-ownership-dune/route")
})

describe("POST /api/cron/sync-topshot-ownership-dune", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/sync-topshot-ownership-dune — success path (inert skip)", () => {
  it("202s with skipped:'dune_not_configured' when Dune is unconfigured (INGEST bearer)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("dune_not_configured")
    expect(body.pipeline).toBe("ownership-sync-dune")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("dune_not_configured")
  })

  it("GET alias reaches the same 202 skip accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})
