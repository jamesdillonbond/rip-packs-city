import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/ufc-enrichment-drain.
// Auth: Bearer INGEST_SECRET_TOKEN (module-const, fail-closed)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the auth check is synchronous, then the whole enrichment drain
// (candidate scan + Flow REST reads + upsert) is deferred inside after() and the
// route returns 202 { accepted:true, pipeline } immediately (CRON-30S pattern).
// after() is stubbed to a no-op so the drain never runs; the immediate accept is
// therefore observable with no DB or chain I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/chains/flow/wallet-backfill-helpers", () => ({
  UFC_COLLECTION_UUID: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/ufc-enrichment-drain/route")
})

describe("POST /api/cron/ufc-enrichment-drain", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/ufc-enrichment-drain — success path (immediate 202 accept)", () => {
  it("202s with accepted:true and the pipeline name once authed (drain deferred)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("ufc-enrichment-drain")
  })
})
