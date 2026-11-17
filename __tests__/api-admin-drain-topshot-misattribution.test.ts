import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/drain-topshot-misattribution.
// Auth (authed()): verifyAdminRequest (Bearer RPC_ADMIN_TOKEN / ?token=) OR
// Bearer INGEST_SECRET_TOKEN OR Bearer CRON_SECRET. Fail-closed: with none of
// the three secrets set, every request is 401. Happy path: an authed request
// whose targets RPC returns [] short-circuits to a 200 "no unresolved targets".

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: [], error: null }),
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}))

import { GET, POST } from "@/app/api/admin/drain-topshot-misattribution/route"

const ADMIN = "test-admin-token"

function req(method: "GET" | "POST", auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/drain-topshot-misattribution", { method, headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.CRON_SECRET
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/drain-topshot-misattribution", () => {
  it("401s when no auth secret is configured (fail-closed)", async () => {
    const res = await POST(req("POST", `Bearer ${ADMIN}`))
    expect(res.status).toBe(401)
  })

  it("401s on GET without a valid token", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await GET(req("GET", "Bearer wrong"))).status).toBe(401)
  })

  it("returns 200 'no unresolved targets' when authed and the queue is empty", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(req("POST", `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.targets).toBe(0)
    expect(body.note).toBe("no unresolved targets")
  })
})
