import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/analytics-smoke. Bearer-gated via
// verifyAdminRequest (RPC_ADMIN_TOKEN). The authed path fans the real smoke run
// into next/server after() (stubbed no-op) and returns 202 immediately — that
//202 ack is the observable success signal, pinned below alongside the guards.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET } from "@/app/api/admin/analytics-smoke/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/analytics-smoke", () => {
  it("exposes a GET handler", () => {
    expect(typeof GET).toBe("function")
  })

  it("401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/analytics-smoke"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(
      adminReq("https://t/api/admin/analytics-smoke", { authorization: "Bearer nope" })
    )
    expect(res.status).toBe(401)
  })

  it("202s and returns the accepted envelope when authed (smoke deferred to after())", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(
      adminReq("https://t/api/admin/analytics-smoke", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("analytics-smoke")
  })
})
