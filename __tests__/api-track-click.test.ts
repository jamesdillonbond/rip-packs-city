import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/track-click. Public outbound-click sink
// that clamps/awaits a single service-role insert into outbound_clicks. A valid
// beacon → { ok: true }; a malformed body (json throws) → 500. Mocks
// @supabase/supabase-js. NOTE: the clamp helpers are covered indirectly here.

const state: { error: any } = { error: null }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async () => ({ error: state.error }) }) }),
}))

import { POST } from "@/app/api/track-click/route"

const req = (body: any, bad = false) =>
  ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

describe("POST /api/track-click", () => {
  it("returns { ok: true } on a valid click beacon", async () => {
    state.error = null
    const res = await POST(req({ surface: "insights", destination: "https://x", askPrice: 10 }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("500s on a malformed body", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})
