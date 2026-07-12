import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/topshot-deal-floor-serials.
// Auth: Bearer INGEST_SECRET_TOKEN or ?token=
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: POST returns an immediate 202 {ok, accepted, pipeline} accept; the
// ~600-call GQL fan-out runs inside after(). after() is stubbed to a no-op so the
// deferred work never executes and the accept is observable with no chain/DB I/O.
// GET is a lightweight status read that AWAITS a supabase count query on the sync
// path — the stub resolves it to a fixed count so we assert editionsWithFloorSerial.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Self-referential chainable + thenable stub. GET's count query awaits the chain
// terminal, resolving to { count, error }.
const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  in: () => sbChain,
  not: () => sbChain,
  limit: () => sbChain,
  order: () => sbChain,
  upsert: () => sbChain,
  then: (r: any) => r({ count: 7, data: [], error: null }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-deal-floor-serials/route")
})

describe("POST /api/cron/topshot-deal-floor-serials", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/topshot-deal-floor-serials — success path (deferred fan-out)", () => {
  it("202s with the pipeline accept when authed (INGEST bearer)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("topshot-deal-floor-serials")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await mod.POST(makeReq({ method: "POST", token: "test-ingest-token" }))
    expect(res.status).toBe(202)
  })

  it("GET reports editionsWithFloorSerial from the count query", async () => {
    const res = await mod.GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editionsWithFloorSerial).toBe(7)
  })
})
