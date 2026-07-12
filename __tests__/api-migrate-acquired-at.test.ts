import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/migrate-acquired-at (POST). Bearer-gated on
// INGEST_SECRET_TOKEN. FAIL-CLOSED AUTH is the priority. Mocks
// @supabase/supabase-js createClient (rpc only) for the authed happy path.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: rpc.data, error: rpc.error }) }),
}))

import { POST } from "@/app/api/migrate-acquired-at/route"

const req = (auth?: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  vi.stubEnv("INGEST_SECRET_TOKEN", "secret-token")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/migrate-acquired-at", () => {
  it("401s without an authorization header", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(req("Bearer wrong"))
    expect(res.status).toBe(401)
  })

  it("runs the migration with the correct bearer token", async () => {
    rpc.data = [{ updated_count: 7 }]
    const res = await POST(req("Bearer secret-token"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.updatedCount).toBe(7)
  })
})
