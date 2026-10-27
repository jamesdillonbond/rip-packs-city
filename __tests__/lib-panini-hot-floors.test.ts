import { describe, it, expect, vi } from "vitest"

/**
 * fetchPaniniHotFloors: `ok` means the READ worked; a non-array payload is a failure, not an empty market.
 * Since 2026-10-27 (#HF) it reads the 30-minute snapshot (hot_floors_snapshot, board panini-blockchain) and
 * computes live only when no snapshot row exists; a failed snapshot read is a failed read.
 */

vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))

import { fetchPaniniHotFloors, PANINI_HOT_FLOORS_DAYS } from "@/lib/hot-floors/panini"

// `snap` is the snapshot table read; `res` the live RPC (used only when no snapshot row exists).
const db = (res: unknown, calls: unknown[] = [], snap: unknown = { data: [], error: null }) => ({
  from: (t: string) => {
    calls.push(["from", t])
    const b: any = { select: () => b, eq: (c: string, v: string) => { calls.push(["eq", c, v]); return b }, limit: () => Promise.resolve(snap) }
    return b
  },
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})

describe("fetchPaniniHotFloors", () => {
  it("reads the snapshot and does NOT compute live when a snapshot exists", async () => {
    const calls: unknown[] = []
    const snap = { data: [{ payload: { editions: [{ external_id: "s" }], newest_sale_at: "2026-10-26T00:00:00Z" }, computed_at: "2026-10-27T14:29:00Z" }], error: null }
    const r = await fetchPaniniHotFloors(db({ data: null, error: null }, calls, snap))
    expect(calls).toEqual([["from", "hot_floors_snapshot"], ["eq", "board", "panini-blockchain"]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "s" }], newestSaleAt: "2026-10-26T00:00:00Z", computedAt: "2026-10-27T14:29:00Z" })
  })
  it("a FAILED snapshot read is a failed read — never a silent live computation", async () => {
    const calls: unknown[] = []
    const r = await fetchPaniniHotFloors(db({ data: { editions: [] }, error: null }, calls, { data: null, error: { message: "timeout" } }))
    expect(r.ok).toBe(false)
    expect(calls.some((c) => (c as unknown[])[0] === "get_panini_hot_floors")).toBe(false)
  })
  it("a snapshot whose editions is not an array is a failed read", async () => {
    const snap = { data: [{ payload: { editions: "nope" }, computed_at: "2026-10-27T14:29:00Z" }], error: null }
    expect((await fetchPaniniHotFloors(db({ data: null, error: null }, [], snap))).ok).toBe(false)
  })
  it("no snapshot yet → reads get_panini_hot_floors over the Panini window", async () => {
    const calls: unknown[] = []
    const r = await fetchPaniniHotFloors(db({ data: { editions: [{ external_id: "a" }], newest_sale_at: "2026-10-26T00:00:00Z" }, error: null }, calls))
    expect(calls).toEqual([["from", "hot_floors_snapshot"], ["eq", "board", "panini-blockchain"], ["get_panini_hot_floors", { p_days: PANINI_HOT_FLOORS_DAYS }]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "a" }], newestSaleAt: "2026-10-26T00:00:00Z", computedAt: null })
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
    const r = await fetchPaniniHotFloors({ from: () => { throw new Error("boom") }, rpc: () => Promise.reject(new Error("boom")) })
    expect(r.ok).toBe(false)
  })
})
