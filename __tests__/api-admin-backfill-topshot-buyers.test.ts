import { describe, it, expect, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for POST /api/admin/backfill-topshot-buyers. Gated on
// Bearer INGEST_SECRET_TOKEN / ?token= (TOKEN captured at module load), so with
// nothing set every request is fail-closed 401.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { POST } from "@/app/api/admin/backfill-topshot-buyers/route"

describe("POST /api/admin/backfill-topshot-buyers", () => {
  it("401s without a valid token (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-buyers"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})
