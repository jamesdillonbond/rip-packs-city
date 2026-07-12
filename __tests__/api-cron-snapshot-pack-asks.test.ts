import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/snapshot-pack-asks.
// Auth: Bearer INGEST_SECRET_TOKEN (read at REQUEST time)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: auth validates SYNCHRONOUSLY then the handler returns 202
// { ok:true, accepted:true } immediately, deferring the live-listings fetch +
// upsert_pack_ask_state + log_pipeline_run to after(). after() is stubbed no-op
// so the accept is observable; @/lib/supabase and the live-pack-listings lib are
// stubbed inert so nothing reaches the network even if after() ran.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/packs/live-pack-listings", () => ({
  SUPPORTED_PACK_COLLECTIONS: [],
  fetchLivePackListings: async () => ({ listings: [] }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/snapshot-pack-asks/route")
})

describe("POST /api/cron/snapshot-pack-asks", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/snapshot-pack-asks — success path (immediate 202 accept, work deferred)", () => {
  it("202s and reports ok:true + accepted:true + the pipeline name with the INGEST bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("snapshot-pack-asks")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})
