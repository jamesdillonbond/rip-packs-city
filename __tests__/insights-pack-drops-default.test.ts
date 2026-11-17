import { describe, it, expect, vi, beforeEach } from "vitest"

// 2026-10-10 (known-issues #33): /insights/pack-drops reads through the board-cache
// ladder. Its builder must report ok:false on an incomplete board, so the reader
// serves the last COMPLETE snapshot and the cron never caches a partial one.

const st = vi.hoisted(() => ({ impl: async (): Promise<unknown[]> => [] }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/pack-drops-board", () => ({ fetchScoredDrops: () => st.impl() }))

import { fetchPackDropsDefault } from "@/lib/insights/pack-drops-default"

beforeEach(() => {
  st.impl = async () => []
})

describe("fetchPackDropsDefault", () => {
  it("a complete board is ok, stamped, and counted", async () => {
    st.impl = async () => [{ drop_id: 7 }, { drop_id: 8 }]
    const r = await fetchPackDropsDefault()
    expect(r.ok).toBe(true)
    expect(r.rowCount).toBe(2)
    expect(r.payload.drops).toHaveLength(2)
    expect(r.payload.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("a genuinely empty market is ok (zero drops is an answer)", async () => {
    const r = await fetchPackDropsDefault()
    expect(r.ok).toBe(true)
    expect(r.rowCount).toBe(0)
  })

  it("an incomplete board (a composition read timed out) is NOT ok: never cached, no stamp, reason kept", async () => {
    st.impl = async () => {
      throw new Error("composition for drop 5 failed: TimeoutError")
    }
    const r = await fetchPackDropsDefault()
    expect(r.ok).toBe(false)
    expect(r.payload.drops).toEqual([])
    expect(r.payload.fetchedAt).toBeNull()
    expect(r.rowCount).toBeNull()
    expect(r.error).toContain("composition for drop 5")
  })
})
