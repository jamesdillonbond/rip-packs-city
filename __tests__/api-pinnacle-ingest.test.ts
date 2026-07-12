import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/pinnacle-ingest.
// POST auth is a ?token= / x-ingest-token check against a MODULE-LEVEL
// INGEST_SECRET const read at import time, so the env is set BEFORE importing.
// Because it's read at import, a missing secret is fail-closed 401 (not 500).
// GET is the unauthenticated pinnacle_health_check monitor. We pin the POST
// 401s and a mocked GET health path. The POST happy path hits Flowty over the
// network (fetchFlowtyPinnacleListings) — no simple seam — so it's not driven.

const rpc: { data: any; error: any } = { data: { moments: 1 }, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET, POST } = await import("@/app/api/pinnacle-ingest/route")

const post = (token?: string, header?: string) => {
  const headers = new Headers()
  if (header) headers.set("x-ingest-token", header)
  const url = token ? `https://t/api/pinnacle-ingest?token=${token}` : "https://t/api/pinnacle-ingest"
  return { url, headers } as any
}

describe("POST /api/pinnacle-ingest", () => {
  it("401s with no token", async () => {
    const res = await POST(post())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong token", async () => {
    expect((await POST(post("wrong"))).status).toBe(401)
    expect((await POST(post(undefined, "wrong"))).status).toBe(401)
  })
})

describe("GET /api/pinnacle-ingest", () => {
  it("returns the health payload (no auth)", async () => {
    rpc.data = { editions: 42 }
    rpc.error = null
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.health).toEqual({ editions: 42 })
  })

  it("500s when the health RPC errors", async () => {
    rpc.error = { message: "db down" }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
    rpc.error = null
  })
})
