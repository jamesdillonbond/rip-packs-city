import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/cart/record. Intentionally unauthenticated
// (called from the browser purchase flow), so there is no bearer guard — the
// guards are input-shape: bad JSON → 400, incomplete rows → {ok,skipped} 200
// (best-effort, no insert), complete rows → insert via supabaseAdmin. We mock
// @/lib/supabase's supabaseAdmin.from().insert to observe the happy path.

const state: { insertError: any; lastRow: any } = { insertError: null, lastRow: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: async (row: any) => {
        state.lastRow = row
        return { error: state.insertError }
      },
    }),
  },
}))

import { POST } from "@/app/api/cart/record/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/cart/record"

const validBody = {
  buyer_address: "0xbd94cade097e50ac",
  listing_resource_id: "12345",
  storefront_address: "0xabc",
  moment_id: "999",
  expected_price: 42,
  status: "success",
}

beforeEach(() => {
  state.insertError = null
  state.lastRow = null
})

describe("POST /api/cart/record", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(makeReq({ url: URL, badJson: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid JSON")
  })

  it("accepts-but-skips an incomplete row (no required fields) without inserting", async () => {
    const res = await POST(makeReq({ url: URL, body: { buyer_address: "0xabc" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, skipped: true })
    expect(state.lastRow).toBeNull()
  })

  it("inserts a complete purchase row and returns ok", async () => {
    const res = await POST(makeReq({ url: URL, body: validBody }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(state.lastRow).not.toBeNull()
    expect(state.lastRow.buyer_address).toBe("0xbd94cade097e50ac")
    expect(state.lastRow.status).toBe("success")
    expect(state.lastRow.completed_at).not.toBeNull()
  })

  it("returns ok:false (still HTTP 200) when the insert errors", async () => {
    state.insertError = { message: "rls denied" }
    const res = await POST(makeReq({ url: URL, body: validBody }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("rls denied")
  })
})
