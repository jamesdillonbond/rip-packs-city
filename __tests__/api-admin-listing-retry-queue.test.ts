import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/listing-retry-queue (GET).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Thin wrapper around get_listing_retry_queue_stats. Pins the 401 and a mocked
// happy path passing the stats JSONB through.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/admin/listing-retry-queue/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/listing-retry-queue", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/listing-retry-queue", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns the stats JSONB on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = { pending: 4, resolved: 10 }
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    expect((await res.json()).pending).toBe(4)
  })

  it("500s on an RPC error", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.error = { message: "boom" }
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(500)
  })
})
