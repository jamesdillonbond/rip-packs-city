import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/pack-calendar. The handler wraps
// fetchPackCalendar(supabase); mock @/lib/insights/pack-calendar (and @/lib/supabase).
// Pins: the happy path, the INCOMPLETE book (complete:false, never read as an empty week),
// and a thrown read → an error status whose body carries no driver text.

const state: { result: any; err: Error | null } = { result: null, err: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/insights/pack-calendar", () => ({
  fetchPackCalendar: async () => {
    if (state.err) throw state.err
    return state.result
  },
}))

import { GET } from "@/app/api/public/insights/pack-calendar/route"

beforeEach(() => {
  state.err = null
  state.result = { complete: true, complete_at: { nba: "2026-11-08T19:50:00Z", nfl: "2026-11-08T19:49:00Z" }, drops: [] }
})

describe("GET /api/public/insights/pack-calendar", () => {
  it("returns the week's drops with the book's completeness", async () => {
    state.result.drops = [{ dist_id: "8916", status: "open" }, { dist_id: "8918", status: "upcoming" }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.drops).toHaveLength(2)
    expect(body.meta).toMatchObject({ complete: true, total_drops: 2 })
    expect(body.meta.complete_at.nba).toBe("2026-11-08T19:50:00Z")
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=900")
  })

  it("an unread book says complete:false — the caller must not post 'no drops'", async () => {
    state.result = { complete: false, complete_at: { nba: null, nfl: null }, drops: [] }
    const body = await (await GET()).json()
    expect(body.meta.complete).toBe(false)
    expect(body.drops).toEqual([])
  })

  it("a failed read is an error status, never an empty 200, and leaks no driver text", async () => {
    state.err = new Error("atlas_pack_market(nba): canceling statement due to statement timeout")
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("statement timeout")
    expect(body.drops).toBeUndefined()
  })
})
