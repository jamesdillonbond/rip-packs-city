import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/prune-logs.
// Auth: Bearer INGEST_SECRET_TOKEN
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: GET runs SYNCHRONOUSLY — it awaits prune_log_tables, sums the
// three *_deleted counts into total_deleted, logs the run, and returns 200
// { ...summary, status:"ok", total_deleted }. The gated weekly-maintenance leg
// is after()-deferred (stubbed no-op). The RPC stub returns a fixture summary so
// the handler reaches its 200 with fixture-derived counts.

// after() is stubbed so the deferred weekly-maintenance leg never runs.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
// Route builds its own client via createClient(); stub the RPC seam:
// prune_log_tables returns the delete-summary fixture, log_pipeline_run is inert.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({}),
    rpc: async (name: string) =>
      name === "prune_log_tables"
        ? {
            data: {
              pipeline_runs_deleted: 5,
              listing_resolution_failures_deleted: 3,
              smoke_test_results_deleted: 2,
            },
            error: null,
          }
        : { data: null, error: null },
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/prune-logs/route")
})

describe("GET /api/cron/prune-logs", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/prune-logs — success path (synchronous prune summary)", () => {
  it("200s with the prune summary and total_deleted summed from the fixture", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.pipeline_runs_deleted).toBe(5)
    expect(body.listing_resolution_failures_deleted).toBe(3)
    expect(body.smoke_test_results_deleted).toBe(2)
    expect(body.total_deleted).toBe(10)
  })
})
