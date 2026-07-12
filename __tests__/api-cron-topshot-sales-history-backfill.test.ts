import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/topshot-sales-history-backfill.
// Auth: Bearer INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the route is SYNCHRONOUS but has a clean, chain-free 2xx — after
// the saturation self-throttle passes (recent-fail count 0) it picks the next
// pending target batch; an EMPTY queue short-circuits to 200
// { ok:true, note:"queue_empty" } BEFORE any TS marketplace GQL is touched. The
// Supabase stub returns count:0 for the throttle head-count and data:[] for the
// target pick, and topshotGraphql is mocked inert, so the queue-empty accept is
// observable with no network / DB I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

// Self-referential chainable + thenable Supabase stub. `then` resolves every
// awaited query builder to { data:[], error:null, count:0 } — count:0 keeps the
// saturation gate open; data:[] makes the target pick return an empty queue.
const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  neq: () => sbChain,
  in: () => sbChain,
  order: () => sbChain,
  limit: () => sbChain,
  gte: () => sbChain,
  not: () => sbChain,
  gt: () => sbChain,
  update: () => sbChain,
  upsert: () => sbChain,
  insert: () => sbChain,
  maybeSingle: async () => ({ data: null, error: null }),
  then: (r: any) => r({ data: [], error: null, count: 0 }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/topshot-sales-history-backfill/route")
})

describe("POST /api/cron/topshot-sales-history-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/topshot-sales-history-backfill — success path (empty queue)", () => {
  it("200s with note:'queue_empty' when no pending targets remain (authed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("queue_empty")
    expect(body.pipeline).toBe("topshot-sales-history-backfill")
  })

  it("GET alias reaches the same queue_empty accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("queue_empty")
  })
})
