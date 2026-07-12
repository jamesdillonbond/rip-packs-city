import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/announcements. Gated on
// ANNOUNCEMENTS_INGEST_TOKEN (deliberately separate from RPC_ADMIN_TOKEN).
// Fail-closed 401 when unset, plus the field-validation 400s (source, title)
// that run before the supabase upsert.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({ upsert: () => ({ select: async () => ({ data: [], error: null }) }) }) } }))

import { POST } from "@/app/api/admin/announcements/route"

beforeEach(() => {
  delete process.env.ANNOUNCEMENTS_INGEST_TOKEN
})
afterEach(() => {
  delete process.env.ANNOUNCEMENTS_INGEST_TOKEN
})

describe("POST /api/admin/announcements", () => {
  it("401s when ANNOUNCEMENTS_INGEST_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/announcements", { body: { source: "topshot", title: "x" } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("400s on an invalid source for an authed request", async () => {
    process.env.ANNOUNCEMENTS_INGEST_TOKEN = "tok"
    const res = await POST(
      adminReq("https://t/api/admin/announcements", { authorization: "Bearer tok", body: { source: "bad", title: "x" } })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("source")
  })

  it("400s on a missing title for an authed request", async () => {
    process.env.ANNOUNCEMENTS_INGEST_TOKEN = "tok"
    const res = await POST(
      adminReq("https://t/api/admin/announcements", { authorization: "Bearer tok", body: { source: "topshot" } })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe("title")
  })
})
