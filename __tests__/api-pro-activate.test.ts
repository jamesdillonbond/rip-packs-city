import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/pro-activate.
// Auth is Bearer against a module-level TOKEN read from INGEST_SECRET_TOKEN at
// IMPORT time, so the env must be set before the dynamic import. Guards:
// 401 (wrong/missing), 400 invalid JSON, 400 without wallet+momentNftId, then
// the activate_pro_from_payment RPC happy path. Mocks @/lib/supabase.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { POST } = await import("@/app/api/pro-activate/route")

function post(auth: string | undefined, body: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/pro-activate", { method: "POST", headers, body })
}

describe("POST /api/pro-activate", () => {
  it("401s with a wrong bearer token", async () => {
    const res = await POST(post("Bearer wrong", "{}"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with no authorization header", async () => {
    expect((await POST(post(undefined, "{}"))).status).toBe(401)
  })

  it("400s on invalid JSON", async () => {
    const res = await POST(post(`Bearer ${TOKEN}`, "{not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON")
  })

  it("400s without wallet and momentNftId", async () => {
    const res = await POST(post(`Bearer ${TOKEN}`, JSON.stringify({ wallet: "0xabc" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet and momentNftId required")
  })

  it("activates and returns 200 with the matching token", async () => {
    rpc.data = { activated: true }
    const res = await POST(
      post(`Bearer ${TOKEN}`, JSON.stringify({ wallet: "0xABC", momentNftId: "123" }))
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ activated: true })
  })

  it("500s on an RPC error", async () => {
    rpc.data = null
    rpc.error = { message: "db down" }
    const res = await POST(
      post(`Bearer ${TOKEN}`, JSON.stringify({ wallet: "0xABC", momentNftId: "123" }))
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
    rpc.error = null
  })
})
