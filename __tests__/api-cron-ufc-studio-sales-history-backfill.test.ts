import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/ufc-studio-sales-history-backfill.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET or ?token= (fail-closed length gate)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// SUCCESS PATH: the route is SYNCHRONOUS but has a clean, GQL-free 2xx — after
// the saturation self-throttle passes (recent-fail count 0) it loads the resume
// state row, and a row with done:true short-circuits to 200
// { ok:true, note:"walk_complete" } BEFORE any studio-platform GQL walk. The
// Supabase stub returns count:0 for the throttle head-count and a done:true
// state row from maybeSingle, so the walk-complete accept is observable with no
// network / DB I/O.

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

// Self-referential chainable + thenable Supabase stub. `then` resolves awaited
// query builders to { count:0 } (throttle gate open); maybeSingle returns the
// resume-state row flagged done:true so the walk-complete branch is taken.
const sbChain: any = {
  from: () => sbChain,
  select: () => sbChain,
  eq: () => sbChain,
  neq: () => sbChain,
  in: () => sbChain,
  not: () => sbChain,
  gte: () => sbChain,
  update: () => sbChain,
  insert: () => sbChain,
  maybeSingle: async () => ({ data: { done: true }, error: null }),
  then: (r: any) => r({ data: [], error: null, count: 0 }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ data: null, error: null }) },
}))

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/ufc-studio-sales-history-backfill/route")
})

describe("POST /api/cron/ufc-studio-sales-history-backfill", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/ufc-studio-sales-history-backfill — success path (walk complete)", () => {
  it("200s with note:'walk_complete' when the resume state is done (authed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toBe("walk_complete")
    expect(body.pipeline).toBe("ufc-studio-sales-history-backfill")
  })

  it("200s via the ?token= query param too", async () => {
    const res = await mod.GET(makeReq({ method: "GET", token: "test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).note).toBe("walk_complete")
  })
})
