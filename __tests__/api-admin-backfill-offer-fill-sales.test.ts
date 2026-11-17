import { describe, it, expect, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Route integration test for /api/admin/backfill-offer-fill-sales. POST is gated
// on Bearer INGEST_SECRET_TOKEN (captured at module load) => fail-closed 401.
// GET is a public, un-gated info endpoint that echoes the event_cursor — mocked
// here and asserted to return the drain hint payload.

const cursor: { data: any; error: any } = {
  data: { last_processed_block: 153_700_000, updated_at: "2026-07-11T00:00:00Z" },
  error: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: cursor.data, error: cursor.error }) }
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

  // ⚠ GET takes NO parameters, so it cannot check the bearer its POST checks,
  // and isPublicPath returns true for /api/admin/* — this payload is served to
  // anyone. It discarded the read error, so a failed cursor read published
  // `ok: true, cursor: null`, which is byte-identical to "the backfill has not
  // started yet" — the exact state an operator reads this probe to learn.
  it("a FAILED cursor read is not published as a not-yet-started backfill", async () => {
    cursor.data = null
    cursor.error = { message: "Timed out acquiring connection from connection pool." }
    try {
      const res = await GET()
      expect(res.status).toBeGreaterThanOrEqual(500)
      const body = await res.json()
      // Assert the ABSENCE of the false claim, not just the presence of an error.
      expect(body.ok).not.toBe(true)
      expect(body).not.toHaveProperty("cursor")
      expect(JSON.stringify(body)).not.toMatch(/connection pool/i)
    } finally {
      cursor.data = { last_processed_block: 153_700_000, updated_at: "2026-07-11T00:00:00Z" }
      cursor.error = null
    }
  })

  it("no cursor row yet is NOT an error — it still reports ok with a null cursor", async () => {
    cursor.data = null
    cursor.error = null
    try {
      const res = await GET()
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.cursor).toBeNull()
    } finally {
      cursor.data = { last_processed_block: 153_700_000, updated_at: "2026-07-11T00:00:00Z" }
    }
  })
})
