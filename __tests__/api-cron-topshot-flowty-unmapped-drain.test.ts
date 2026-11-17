import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/topshot-flowty-unmapped-drain.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET or ?token= (fail-closed length gate)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the getMintedMoment resolution loop is live proxy I/O, but the
// empty-backlog branch is fully drivable offline. An authed run passes the
// saturation gate (recent-fail count 0) then reads zero candidate rows and returns
// 200 {ok, found:0, note:"no_candidates"} before any proxy call. supabaseAdmin is a
// chainable+thenable stub: the saturation head-count resolves to {count:0} and the
// candidate select resolves to {data:[]}, both from the shared terminal.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  neq: () => sbChain,
  gte: () => sbChain,
  is: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  update: () => sbChain,
  upsert: () => sbChain,
  in: () => sbChain,
  then: (r: any) => r({ count: 0, data: [], error: null }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-flowty-unmapped-drain/route")
})

describe("POST /api/cron/topshot-flowty-unmapped-drain", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/topshot-flowty-unmapped-drain — success path (empty backlog)", () => {
  it("200s with note:'no_candidates' when the backlog is empty (INGEST bearer)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.found).toBe(0)
    expect(body.note).toBe("no_candidates")
    expect(body.pipeline).toBe("topshot-flowty-unmapped-drain")
  })

  it("GET alias reaches the same empty-backlog accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("no_candidates")
  })
})
