import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/refresh-cross-collection.
// Auth: Bearer INGEST_SECRET_TOKEN or ?token= (reads new URL(req.url))
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
//
// Success path: this route runs the two refresh RPCs SYNCHRONOUSLY (no after())
// and reflects each RPC's returned jsonb straight into the response body
// (step1/step2). The route builds its own client via createClient(@supabase/
// supabase-js), so we mock that seam to return shaped fixtures and assert the
// fixture-derived fields (step1.cohort_size / step2.set_overlap_rows) plus ok=true.

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string) => {
      if (name === "refresh_cross_collection_cohort_step1")
        return { data: { cohort_size: 42, computed_at: "2026-07-12T00:00:00Z" }, error: null }
      if (name === "refresh_cross_collection_cohort_step2")
        return { data: { set_overlap_rows: 7, computed_at: "2026-07-12T00:00:00Z" }, error: null }
      return { data: null, error: null } // log_pipeline_run
    },
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/refresh-cross-collection/route")
})

describe("POST /api/cron/refresh-cross-collection", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/refresh-cross-collection — success path", () => {
  it("200s and reflects both refreshed steps with the correct bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.error).toBeNull()
    expect(body.step1.cohort_size).toBe(42)
    expect(body.step2.set_overlap_rows).toBe(7)
  })

  it("200s via the ?token= query param too", async () => {
    const res = await mod.POST(makeReq({ method: "POST", token: "test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
  })
})
