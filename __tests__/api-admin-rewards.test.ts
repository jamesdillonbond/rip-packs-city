import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/rewards (GET/POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pins the fail-closed 401 on both verbs and the POST unknown-action 400.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/rewards", () => ({ adminAdjust: async () => ({ ok: true }) }))

import { GET, POST } from "@/app/api/admin/rewards/route"

const ADMIN = "test-admin-token"

function req(method: "GET" | "POST", body?: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  const init: any = { method, headers }
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body)
  return new NextRequest("https://t/api/admin/rewards", init)
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})

describe("/api/admin/rewards", () => {
  it("401s fail-closed on GET when no token env is set", async () => {
    expect((await GET(req("GET", undefined, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("401s fail-closed on POST when no token env is set", async () => {
    expect((await POST(req("POST", { action: "adjust" }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s on an unknown POST action when authed", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(req("POST", { action: "nope" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown action: nope")
  })
})
