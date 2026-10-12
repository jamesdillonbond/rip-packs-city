import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/analytics-overview. Auth accepts
// Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN; both unset => fail-closed 401.
// Authed happy path proxies the SECDEF get_admin_analytics_overview() RPC.

const rpc: { data: any; error: any } = { data: null, error: null }
// 2026-10-11 (M3): the route ALSO calls get_rpc_traction_activity(); its outcome
// is independent of the overview's and is attached as `traction` / `traction_error`.
const tractionRpc: { data: any; error: any } = { data: null, error: null }
const calls: string[] = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      calls.push(name)
      if (name === "get_rpc_traction_activity") return { data: tractionRpc.data, error: tractionRpc.error }
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/admin/analytics-overview/route"

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  tractionRpc.data = { wau: 2, mau: 5 }
  tractionRpc.error = null
  calls.length = 0
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.RPC_ADMIN_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.RPC_ADMIN_TOKEN
})

describe("GET /api/admin/analytics-overview", () => {
  it("401s when neither token is configured (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/analytics-overview"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("returns the RPC payload for an authed request", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    rpc.data = { active_users: 42 }
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active_users: 42, traction: { wau: 2, mau: 5 }, traction_error: null })
    expect(calls).toEqual(["get_admin_analytics_overview", "get_rpc_traction_activity"])
  })

  it("a FAILED traction read does not fail the overview: traction:null + the error string, never a 0", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    rpc.data = { active_users: 42 }
    tractionRpc.data = null
    tractionRpc.error = { message: "function public.get_rpc_traction_activity() does not exist" }
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.active_users).toBe(42)
    expect(json.traction).toBeNull()
    expect(json.traction_error).toMatch(/does not exist/)
    expect(JSON.stringify(json)).not.toMatch(/"wau":0/)
  })

  it("a traction read that returns no payload is reported, not rendered as an empty block", async () => {
    process.env.RPC_ADMIN_TOKEN = "secret"
    rpc.data = {}
    tractionRpc.data = null
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer secret" })
    )
    const json = await res.json()
    expect(json.traction).toBeNull()
    expect(json.traction_error).toMatch(/no payload/)
  })

  it("500s on an RPC error for an authed request", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    rpc.error = { message: "db down" }
    const res = await GET(
      adminReq("https://t/api/admin/analytics-overview", { authorization: "Bearer ingest" })
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
