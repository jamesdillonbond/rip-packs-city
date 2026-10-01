import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/track-click. Public outbound-click sink
// that clamps/awaits a single service-role insert into outbound_clicks. A valid
// beacon → { ok: true }; a malformed body (json throws) → 500. Mocks
// @supabase/supabase-js. NOTE: the clamp helpers are covered indirectly here.

const state: { error: any; rows: any[] } = { error: null, rows: [] }
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async (r: any) => { state.rows.push(r); return { error: state.error } } }) }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))

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

  // audit_20260930: this route used to answer { ok: true } after a FAILED insert —
  // a lost click reported as a recorded one. `ok` now means the row landed.
  it("a FAILED insert is a 500 with ok:false, never ok:true", async () => {
    state.error = { message: "insert failed" }
    const res = await POST(req({ surface: "sniper", momentId: "1" }))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    state.error = null
  })

  it("writes the collection as the long-form slug, from either spelling; an unknown one is NULL, not a default", async () => {
    state.rows = []
    await POST(req({ surface: "sniper", collection: "nba-top-shot", momentId: "1" }))
    await POST(req({ surface: "sniper", collection: "nfl_all_day", momentId: "2" }))
    await POST(req({ surface: "sniper", collection: "made-up", momentId: "3" }))
    expect(state.rows.map((r) => r.collection_slug)).toEqual(["nba_top_shot", "nfl_all_day", null])
    expect(state.rows.every((r) => r.source === "site")).toBe(true)
  })

  it("500s on a malformed body", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})
