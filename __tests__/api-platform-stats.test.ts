import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/platform-stats (public, no auth).
// Thin wrapper around the get_platform_stats RPC.
//
// This file used to assert that a failed read "degrades to a 200
// { error: 'stats_unavailable' }". That contract was retired 2026-08-09: it is
// an exact copy of the deep-audit D11 trap that was live on
// /api/collection-stats, where a caller's idiomatic `if (!res.ok) throw` let the
// error body through as data and rendered zeros for a failed read. A failed read
// now carries a failed status and a classified, non-leaking body.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/platform-stats/route"

beforeEach(() => {
  rpc.data = null
  rpc.error = null
})

describe("GET /api/platform-stats", () => {
  it("returns the stats payload on success", async () => {
    rpc.data = { wallets: 42, moments: 1000 }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallets: 42, moments: 1000 })
  })

  // An unclassifiable driver error is `internal` (500), not `timeout` (503) —
  // an unrecognized failure is not assumed retryable. The load-bearing property
  // is that it is NOT 200.
  it("fails with a real status on an RPC error, and does not leak the driver message", async () => {
    rpc.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.json()
    expect(body.code).toBe("internal")
    expect(JSON.stringify(body)).not.toContain("db down")
  })

  it("503s + Retry-After on a statement timeout, so callers can back off", async () => {
    rpc.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET()
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("30")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })
})
