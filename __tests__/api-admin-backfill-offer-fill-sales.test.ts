import { describe, it, expect, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-offer-fill-sales. POST is gated
// on Bearer INGEST_SECRET_TOKEN (captured at module load) => fail-closed 401.
// GET is a public, un-gated info endpoint that echoes the event_cursor — mocked
// here and asserted to return the drain hint payload.

const cursor: { data: any } = { data: { last_processed_block: 153_700_000, updated_at: "2026-07-11T00:00:00Z" } }

vi.mock("@/lib/supabase", () => {
  const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: cursor.data }) }
  return { supabaseAdmin: { from: () => b } }
})

import { GET, POST } from "@/app/api/admin/backfill-offer-fill-sales/route"

describe("/api/admin/backfill-offer-fill-sales", () => {
  it("POST 401s without a valid token (fail-closed)", async () => {
    const res = await POST(adminReq("https://t/api/admin/backfill-offer-fill-sales", { authorization: "Bearer wrong" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("GET returns the un-gated cursor info payload", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.note).toContain("POST with Bearer INGEST_SECRET_TOKEN")
    expect(body.cursor).toEqual(cursor.data)
  })
})
