import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/beta-activity. Auth accepts Bearer
// RPC_ADMIN_TOKEN OR INGEST_SECRET_TOKEN (both request-time). None set =>
// fail-closed 401 with a lower-case "unauthorized" body. Success path: the
// allow_list / user_profiles / usage_events reads + auth.admin.listUsers are all
// mocked empty, so the rollup returns a synchronous 200 {user_count:0, rows:[]}.

vi.mock("@/lib/supabase", () => {
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    in: () => sb,
    gte: () => sb,
    order: async () => ({ data: [], error: null }),
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  }
  return { supabaseAdmin: sb }
})

import { GET } from "@/app/api/admin/beta-activity/route"

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})

describe("GET /api/admin/beta-activity", () => {
  it("401s when no token is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/beta-activity"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer even when a token is configured", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/beta-activity", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("200s an empty rollup when there are no active beta users (authed)", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    const res = await GET(adminReq("https://t/api/admin/beta-activity", { authorization: "Bearer secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user_count).toBe(0)
    expect(Array.isArray(body.rows)).toBe(true)
    expect(body.rows.length).toBe(0)
  })
})
