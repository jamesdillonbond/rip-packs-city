import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/backfill-badges-from-sets. Gated on
// Bearer INGEST_SECRET_TOKEN (read at request time). Fail-closed 401 is the
// high-value assertion; the authed path drives paginated GQL/DB catalog work
// with no simple mock seam, so it is not exercised here.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))

import { POST } from "@/app/api/admin/backfill-badges-from-sets/route"

beforeEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("POST /api/admin/backfill-badges-from-sets", () => {
  it("401s when INGEST_SECRET_TOKEN is unset (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-badges-from-sets"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer even when the token is configured", async () => {
    process.env.INGEST_SECRET_TOKEN = "ingest"
    const res = await POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer nope" })
    )
    expect(res.status).toBe(401)
  })
})
