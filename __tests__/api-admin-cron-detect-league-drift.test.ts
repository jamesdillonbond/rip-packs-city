import { describe, it, expect, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for GET /api/admin/cron/detect-league-drift. Gated on
// Bearer INGEST_SECRET_TOKEN / ?token= (TOKEN captured at module load), so with
// nothing set every request is fail-closed 401 with an {ok:false} envelope.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET } from "@/app/api/admin/cron/detect-league-drift/route"

describe("GET /api/admin/cron/detect-league-drift", () => {
  it("401s without a valid token (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/cron/detect-league-drift"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer", async () => {
    const res = await GET(adminReq("https://t/api/admin/cron/detect-league-drift", { authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
  })
})
