import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-catalog (GET + POST
// share handle()). Bearer-gated via verifyAdminRequest (RPC_ADMIN_TOKEN).
// None set => fail-closed 401 on both verbs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-topshot-catalog/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/backfill-topshot-catalog", () => {
  it("GET 401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-catalog"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s the stale-thumbnails mode with 0 sets when none are stale (authed)", async () => {
    // topshot_sets_with_stale_thumbnails mocked [] → early return, no GQL walk.
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.sets_processed).toBe(0)
    expect(body.terminated_reason).toBe("no_stale_thumbnails")
  })
})
