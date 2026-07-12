import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/rewards (GET/POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pins the fail-closed 401 on both verbs, the POST unknown-action 400, and two
// 2xx paths: an authed GET rollup (every reward view mocked empty → an empty
// economy envelope) and an authed POST adjust (adminAdjust mocked ok).

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    in: () => sb,
    order: () => sb,
    limit: () => sb,
    update: () => sb,
    upsert: () => sb,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return { supabaseAdmin: sb }
})
vi.mock("@/lib/rewards", () => ({ adminAdjust: async () => ({ ok: true, balance: 100 }) }))

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

  it("200s the rewards rollup on an authed GET (all views mocked empty)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req("GET", undefined, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.economy).toBe(null)
    expect(Array.isArray(body.balances)).toBe(true)
    expect(Array.isArray(body.pending)).toBe(true)
  })

  it("200s a POST adjust when authed (adminAdjust mocked ok)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(
      req("POST", { action: "adjust", userId: "user-1", delta: 50, statusDelta: 0, reason: "comp" }, `Bearer ${ADMIN}`)
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result.ok).toBe(true)
  })
})
