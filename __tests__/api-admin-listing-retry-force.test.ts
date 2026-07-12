import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/listing-retry-force (POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pins the 401, the id-required 400, a 404 when the row is absent, and a 2xx
// success: an already-resolved row short-circuits to {ok:true, already_resolved:
// true} before any Cadence/Flow I/O. The listing_resolution_failures lookup is
// driven via a hoisted mutable holder so each test picks the returned row.

const state = vi.hoisted(() => ({ row: { data: null as any, error: null as any } }))
vi.mock("@/lib/supabase", () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => state.row,
    update: () => chain,
  }
  return { supabaseAdmin: { from: () => chain } }
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
  state.row = { data: null, error: null }
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  state.row = { data: null, error: null }
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

  it("200s already_resolved when the row is already resolved (authed, pre-I/O)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    state.row = { data: { id: 7, resolved_at: "2026-07-01T00:00:00Z" }, error: null }
    const res = await POST(post("?id=7", `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.already_resolved).toBe(true)
    expect(body.resolved_at).toBe("2026-07-01T00:00:00Z")
  })
})
