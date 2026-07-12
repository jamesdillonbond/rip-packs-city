import { describe, it, expect, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-allday-buyers (GET + POST share
// one handler). Auth accepts Bearer INGEST_SECRET_TOKEN / CRON_SECRET / ?token=;
// the tokens are captured at module load, so with none set every request is
// fail-closed 401. (Authed happy path omitted — it drives a live Cadence/Flow
// walk with no simple mock seam.)

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/admin/backfill-allday-buyers/route"

describe("/api/admin/backfill-allday-buyers", () => {
  it("GET 401s without a valid token (fail-closed)", async () => {
    const res = await GET(adminReq("https://t/api/admin/backfill-allday-buyers"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("POST 401s without a valid token (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-allday-buyers", { authorization: "Bearer wrong" }))
    expect(res.status).toBe(401)
  })
})
