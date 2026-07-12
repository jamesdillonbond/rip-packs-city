import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/drain-fmv-cold-tail. Gated on
// Bearer INGEST_SECRET_TOKEN / ?token= via isAuthorized() (request-time). None
// set => fail-closed 401 with a lower-case "unauthorized" body.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { POST } from "@/app/api/admin/drain-fmv-cold-tail/route"

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/admin/drain-fmv-cold-tail", () => {
  it("401s when INGEST_SECRET_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/drain-fmv-cold-tail"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(adminReq("https://t/api/admin/drain-fmv-cold-tail", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})
