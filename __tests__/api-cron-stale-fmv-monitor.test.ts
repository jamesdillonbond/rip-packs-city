import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/stale-fmv-monitor.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET (500 misconfig when token env unset; 401 when set + wrong)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path is SYNCHRONOUS: after auth, the route awaits a Promise.all of 5
// reads (@supabase/supabase-js createClient) — latest FMV computed_at, latest
// sale sold_at, and three editions count(*)s — then returns 200 with a computed
// staleness verdict. The createClient stub is a self-referential chain whose
// thenable resolves a fixture supplying BOTH the latest-row data ({ computed_at,
// sold_at }) and count:0, so a recent computed_at drives status:"ok" and 0
// orphans drives data_integrity_ok:true, all without DB I/O. @/lib/ops-alert is
// stubbed inert (only the stale branch would call it).

const RECENT_ISO = new Date().toISOString()
const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  is: () => sbChain,
  then: (resolve: any) =>
    resolve({ data: [{ computed_at: RECENT_ISO, sold_at: RECENT_ISO }], count: 0, error: null }),
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sbChain }))
vi.mock("@/lib/ops-alert", () => ({ sendOpsAlert: async () => {} }))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/stale-fmv-monitor/route")
})

describe("GET /api/cron/stale-fmv-monitor", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/stale-fmv-monitor — success path (fresh FMV, clean integrity)", () => {
  it("200s with status:'ok' and data_integrity_ok:true when FMV is fresh and no orphans", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.data_integrity_ok).toBe(true)
    expect(body.editions_no_set).toBe(0)
    expect(body.fmv_threshold_minutes).toBe(45)
  })
})
