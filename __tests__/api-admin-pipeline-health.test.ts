import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/pipeline-health (GET).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pulls pipeline_runs via query_sql and classifies cadence drift. With no rows
// every known pipeline classifies red/expected_but_missing. Pins the 401 and
// the empty-window happy path.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/admin/pipeline-health/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/pipeline-health", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/pipeline-health", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("classifies every known pipeline as expected_but_missing on an empty window", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = []
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.green).toBe(0)
    expect(body.summary.expected_but_missing).toBeGreaterThan(0)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it("500s on an RPC error", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "boom" }
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(500)
  })
})
