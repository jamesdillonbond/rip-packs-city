import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-topshot-onchain-art (GET + POST
// share handle()). Auth via authed(): verifyAdminRequest OR INGEST / CRON.
// None set => fail-closed 401. With the null-art editions select mocked empty,
// the resolver loop never runs (no on-chain CID fetch), so the authed request
// returns a synchronous 200 {ok:true, candidates:0, scanned:0}.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    or: () => sb,
    not: () => sb,
    order: () => sb,
    update: () => sb,
    insert: async () => ({ data: null, error: null }),
    limit: async () => ({ data: [], error: null }),
  }
  return { supabaseAdmin: sb }
})

import { GET, POST } from "@/app/api/admin/backfill-topshot-onchain-art/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("/api/admin/backfill-topshot-onchain-art", () => {
  it("GET 401s when RPC_ADMIN_TOKEN is unset (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-onchain-art"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s with a wrong bearer even when the token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-onchain-art", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s with 0 candidates when no editions lack art (authed)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/backfill-topshot-onchain-art", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.candidates).toBe(0)
    expect(body.scanned).toBe(0)
  })
})
