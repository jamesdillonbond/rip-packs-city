import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/refresh-flowty-analytics (POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR CRON_SECRET, fail-closed.
// Calls refresh_flowty_analytics and spreads its JSONB. Pins the 401 and a
// mocked happy path.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { POST } from "@/app/api/admin/refresh-flowty-analytics/route"

const INGEST = "test-ingest-token"

function post(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/refresh-flowty-analytics", { method: "POST", headers })
}

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
})

describe("POST /api/admin/refresh-flowty-analytics", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await POST(post(`Bearer ${INGEST}`))).status).toBe(401)
  })

  it("returns ok + spreads the RPC summary on the happy path", async () => {
    process.env.INGEST_SECRET_TOKEN = INGEST
    rpc.data = { refreshed: 3 }
    const res = await POST(post(`Bearer ${INGEST}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.refreshed).toBe(3)
  })

  it("500s on an RPC error", async () => {
    process.env.INGEST_SECRET_TOKEN = INGEST
    rpc.error = { message: "boom" }
    expect((await POST(post(`Bearer ${INGEST}`))).status).toBe(500)
  })
})
