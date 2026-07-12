import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"

// Route-integration test for /api/cron/topshot-flowty-sales-history-backfill.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET or ?token= (fail-closed length gate)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the bulk of this route is SYNCHRONOUS live Flow REST block-scanning
// (no after()), so the full ingest is not cleanly drivable offline. The one 2xx we
// CAN drive without live chain I/O is the documented kill-switch: with
// TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED=1 an authed run short-circuits to 200
// {ok, skipped:"disabled", pipeline} before any scan. supabaseAdmin is stubbed inert
// (the disabled branch's log_pipeline_run rpc is in a try/catch); dapper-v1-tx-decode
// is stubbed so the import graph resolves.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeTopShotSaleTx: async () => ({ buyer: null, seller: null }),
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-flowty-sales-history-backfill/route")
})

afterEach(() => {
  delete process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED
})

describe("POST /api/cron/topshot-flowty-sales-history-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/topshot-flowty-sales-history-backfill — success path (kill switch)", () => {
  it("200s with skipped:'disabled' when the kill switch is set (INGEST bearer)", async () => {
    process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED = "1"
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("disabled")
    expect(body.pipeline).toBe("topshot-flowty-sales-history-backfill")
  })

  it("GET alias reaches the same disabled accept when authed", async () => {
    process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED = "true"
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).skipped).toBe("disabled")
  })
})
