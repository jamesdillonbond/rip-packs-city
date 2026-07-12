import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/track-funnel. Public funnel-event sink
// with an event_type allowlist. An unknown/blank event_type is rejected quietly
// (200 { ok: false }); an allowed type awaits a service-role insert → { ok: true }.
// Mocks @supabase/supabase-js.

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
}))

import { POST } from "@/app/api/track-funnel/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/track-funnel", () => {
  it("rejects an unknown event_type with 200 { ok: false }", async () => {
    const res = await POST(req({ eventType: "not-allowed" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(false)
  })

  it("accepts an allowlisted event_type", async () => {
    const res = await POST(req({ eventType: "home_view", surface: "home" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("500s on a malformed body", async () => {
    expect((await POST(req(null, true))).status).toBe(500)
  })
})
