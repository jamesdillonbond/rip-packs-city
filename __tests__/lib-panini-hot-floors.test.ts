import { describe, it, expect, vi } from "vitest"

/** fetchPaniniHotFloors: `ok` means the READ worked; a non-array payload is a failure, not an empty market. */

vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))

import { fetchPaniniHotFloors, PANINI_HOT_FLOORS_DAYS } from "@/lib/hot-floors/panini"

const db = (res: unknown, calls: unknown[] = []) => ({
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})

describe("fetchPaniniHotFloors", () => {
  it("reads get_panini_hot_floors over the Panini window", async () => {
    const calls: unknown[] = []
    const r = await fetchPaniniHotFloors(db({ data: { editions: [{ external_id: "a" }], newest_sale_at: "2026-10-26T00:00:00Z" }, error: null }, calls))
    expect(calls).toEqual([["get_panini_hot_floors", { p_days: PANINI_HOT_FLOORS_DAYS }]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "a" }], newestSaleAt: "2026-10-26T00:00:00Z" })
  })
  it("an empty list is a real, ok answer", async () => {
    expect((await fetchPaniniHotFloors(db({ data: { editions: [] }, error: null }))).ok).toBe(true)
  })
  it("an error, a missing list or a non-array is a failed read", async () => {
    expect((await fetchPaniniHotFloors(db({ data: null, error: { message: "x" } }))).ok).toBe(false)
    expect((await fetchPaniniHotFloors(db({ data: {}, error: null }))).ok).toBe(false)
    expect((await fetchPaniniHotFloors(db({ data: { editions: "nope" }, error: null }))).ok).toBe(false)
  })
  it("a thrown read is a failed read", async () => {
    const r = await fetchPaniniHotFloors({ rpc: () => Promise.reject(new Error("boom")) })
    expect(r.ok).toBe(false)
  })
})
