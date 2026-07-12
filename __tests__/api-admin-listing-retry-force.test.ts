import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/listing-retry-force (POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pins the 401, the id-required 400, and a 404 when the row is absent (mocked
// listing_resolution_failures lookup returning null).

vi.mock("@/lib/supabase", () => {
  const row: any = { data: null, error: null }
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => row,
  }
  return { supabaseAdmin: { from: () => chain }, __row: row }
})

import { POST } from "@/app/api/admin/listing-retry-force/route"

const ADMIN = "test-admin-token"

function post(query: string, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(`https://t/api/admin/listing-retry-force${query}`, { method: "POST", headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/listing-retry-force", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await POST(post("?id=1", `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s when id is missing or non-numeric", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await POST(post("", `Bearer ${ADMIN}`))).status).toBe(400)
    expect((await POST(post("?id=abc", `Bearer ${ADMIN}`))).status).toBe(400)
  })

  it("404s when the row does not exist", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post("?id=99", `Bearer ${ADMIN}`))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("row not found")
  })
})
