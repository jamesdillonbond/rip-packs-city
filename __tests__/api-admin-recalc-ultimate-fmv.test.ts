import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/recalc-ultimate-fmv (GET/POST).
// Its own gate: a missing RPC_ADMIN_TOKEN returns 500 admin_token_not_configured
// (NOT 401), a wrong token returns 401, a correct token runs recalc_ultimate_fmv
// via createClient. Mocks @supabase/supabase-js.

const rpc: { data: any; error: any } = { data: null, error: null }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: async () => ({ data: rpc.data, error: rpc.error }) }),
}))

import { GET, POST } from "@/app/api/admin/recalc-ultimate-fmv/route"

const ADMIN = "test-admin-token"

function req(method: "GET" | "POST", auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/recalc-ultimate-fmv", { method, headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  rpc.data = null
  rpc.error = null
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/recalc-ultimate-fmv", () => {
  it("500s admin_token_not_configured when RPC_ADMIN_TOKEN is unset", async () => {
    const res = await GET(req("GET", `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("admin_token_not_configured")
  })

  it("401s on a wrong token when configured", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await POST(req("POST", "Bearer nope"))).status).toBe(401)
  })

  it("runs the recalc RPC on the happy path", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    rpc.data = [{ updated: 5 }]
    const res = await POST(req("POST", `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ updated: 5 })
  })
})
