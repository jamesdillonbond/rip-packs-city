import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/price-snapshots.
// Auth: POST gated on Bearer INGEST_SECRET_TOKEN (GET is a public status probe)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: POST runs SYNCHRONOUSLY — it awaits the RPC
// populate_price_snapshots_hourly and spreads its result into the 200 body
// ({ status:"ok", ...data }). The stub returns a fixture so the handler reaches
// that 200 and the body carries fixture-derived fields.

// Route builds its own client via createClient(); stub the RPC seam so the
// synchronous populate_price_snapshots_hourly returns a fixture.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({}),
    rpc: async () => ({
      data: { editions_snapshotted: 42, bucket: "2026-07-12T00:00:00Z" },
      error: null,
    }),
  }),
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/price-snapshots/route")
})

describe("POST /api/cron/price-snapshots", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/price-snapshots — success path (synchronous RPC result)", () => {
  it("200s with status ok and the RPC's snapshot summary spread into the body", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.editions_snapshotted).toBe(42)
    expect(body.bucket).toBe("2026-07-12T00:00:00Z")
  })
})
