import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/pack-drops. The handler is a
// thin wrapper over fetchScoredDrops(supabase); mock @/lib/pack-drops-board (and
// @/lib/supabase). No auth guard — pins the happy path (drops + total_drops meta)
// and the thrown-error → 500 path.

const state: { drops: any[]; err: Error | null } = { drops: [], err: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/pack-drops-board", () => ({
  fetchScoredDrops: async () => { if (state.err) throw state.err; return state.drops },
}))

import { GET } from "@/app/api/public/insights/pack-drops/route"

beforeEach(() => { state.drops = []; state.err = null })

describe("GET /api/public/insights/pack-drops", () => {
  it("returns scored drops on the happy path", async () => {
    state.drops = [{ drop_id: 1, verdict: "worth-it" }, { drop_id: 2, verdict: "skip" }]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.drops).toHaveLength(2)
    expect(body.meta.total_drops).toBe(2)
    expect(body.meta.source).toContain("vaultopolis")
  })

  it("returns an empty drops array when nothing is discovered", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.drops).toEqual([])
    expect(body.meta.total_drops).toBe(0)
  })

  it("500s when fetchScoredDrops throws", async () => {
    state.err = new Error("vaultopolis down")
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("vaultopolis down")
  })

  it("500s and String()-coerces a non-Error throw", async () => {
    state.err = "raw drop failure" as unknown as Error
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("raw drop failure")
  })
})
