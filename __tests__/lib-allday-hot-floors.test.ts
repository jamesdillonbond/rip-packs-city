import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * fetchAllDayHotFloors (All Day ↔ Top Shot parity, 2026-10-26): `ok` means the READ worked; a non-array
 * payload is a failure, not an empty market. Plus the page/registry wiring: All Day's `hot-floors`
 * permission is backed by an All Day arm that returns before the Top Shot Quick-Buy read.
 */

vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))

import { fetchAllDayHotFloors, ALLDAY_HOT_FLOORS_DAYS, ALLDAY_HOT_FLOORS_SNAPSHOT_MAX_AGE_MS } from "@/lib/hot-floors/allday"
import { collectionHasPage } from "@/lib/collections"

// `snap` is the snapshot table read; `res` the live RPC (used only when no snapshot row exists).
const db = (res: unknown, calls: unknown[] = [], snap: unknown = { data: [], error: null }) => ({
  from: (t: string) => {
    calls.push(["from", t])
    const b: any = { select: () => b, eq: () => b, limit: () => Promise.resolve(snap) }
    return b
  },
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")
/** A computed_at N minutes ago — snapshot rows are age-gated (2026-10-27), so fixtures must be relative. */
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

describe("fetchAllDayHotFloors", () => {
  it("reads the 15-minute snapshot and does NOT compute live when a snapshot exists", async () => {
    const calls: unknown[] = []
    const at = minsAgo(9)
    const snap = { data: [{ payload: { editions: [{ external_id: "6112" }], newest_sale_at: "2026-10-27T03:00:00Z" }, computed_at: at }], error: null }
    const r = await fetchAllDayHotFloors(db({ data: null, error: null }, calls, snap))
    expect(calls).toEqual([["from", "allday_hot_floors_snapshot"]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "6112" }], newestSaleAt: "2026-10-27T03:00:00Z", computedAt: at })
  })
  it("a STALE snapshot (older than its max age) is not served — the page computes live (2026-10-27)", async () => {
    const calls: unknown[] = []
    const snap = { data: [{ payload: { editions: [{ external_id: "old" }] }, computed_at: minsAgo(ALLDAY_HOT_FLOORS_SNAPSHOT_MAX_AGE_MS / 60_000 + 5) }], error: null }
    const r = await fetchAllDayHotFloors(db({ data: { editions: [{ external_id: "live" }] }, error: null }, calls, snap))
    expect(calls.some((c) => (c as unknown[])[0] === "get_allday_hot_floors")).toBe(true)
    expect(r.editions).toEqual([{ external_id: "live" }])
    expect(r.computedAt).toBeNull()
  })
  it("an UNDATED snapshot cannot prove it is current — computed live", async () => {
    const calls: unknown[] = []
    const snap = { data: [{ payload: { editions: [{ external_id: "old" }] }, computed_at: null }], error: null }
    await fetchAllDayHotFloors(db({ data: { editions: [] }, error: null }, calls, snap))
    expect(calls.some((c) => (c as unknown[])[0] === "get_allday_hot_floors")).toBe(true)
  })
  it("a FAILED snapshot read is a failed read — never a silent live computation", async () => {
    const calls: unknown[] = []
    const r = await fetchAllDayHotFloors(db({ data: { editions: [] }, error: null }, calls, { data: null, error: { message: "timeout" } }))
    expect(r.ok).toBe(false)
    expect(calls.some((c) => (c as unknown[])[0] === "get_allday_hot_floors")).toBe(false)
  })
  it("no snapshot yet → reads get_allday_hot_floors over the All Day window", async () => {
    const calls: unknown[] = []
    const r = await fetchAllDayHotFloors(db({ data: { editions: [{ external_id: "3201" }], newest_sale_at: "2026-10-27T00:51:49Z" }, error: null }, calls))
    expect(calls).toEqual([["from", "allday_hot_floors_snapshot"], ["get_allday_hot_floors", { p_days: ALLDAY_HOT_FLOORS_DAYS }]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "3201" }], newestSaleAt: "2026-10-27T00:51:49Z", computedAt: null })
  })
  it("an empty list is a real, ok answer", async () => {
    expect((await fetchAllDayHotFloors(db({ data: { editions: [] }, error: null }))).ok).toBe(true)
  })
  it("an error, a missing list or a non-array is a failed read", async () => {
    expect((await fetchAllDayHotFloors(db({ data: null, error: { message: "x" } }))).ok).toBe(false)
    expect((await fetchAllDayHotFloors(db({ data: {}, error: null }))).ok).toBe(false)
    expect((await fetchAllDayHotFloors(db({ data: { editions: "nope" }, error: null }))).ok).toBe(false)
  })
  it("a thrown read is a failed read", async () => {
    const throwing = { from: () => { const b: any = { select: () => b, eq: () => b, limit: () => Promise.resolve({ data: [], error: null }) }; return b }, rpc: () => Promise.reject(new Error("boom")) }
    expect((await fetchAllDayHotFloors(throwing)).ok).toBe(false)
  })
})

describe("All Day hot-floors wiring", () => {
  it("the registry ships hot-floors for All Day", () => {
    expect(collectionHasPage("nfl-all-day", "hot-floors")).toBe(true)
  })
  it("the All Day arm returns before the Top Shot-only branch and the Quick-Buy read", () => {
    const page = read("app/(collections)/[collection]/hot-floors/page.tsx")
    const arm = page.indexOf('collectionId === "nfl-all-day"')
    expect(arm).toBeGreaterThan(-1)
    expect(arm).toBeLessThan(page.indexOf('collectionId !== "nba-top-shot"'))
    expect(arm).toBeLessThan(page.indexOf("await fetchHotFloors()"))
    expect(page).toContain("fetchAllDayHotFloors()")
    expect(page).toContain("<AllDayHotFloors")
    expect(read("lib/hot-floors/allday.ts")).toContain('db.rpc("get_allday_hot_floors"')
  })
  it("the Flow Sniper links Hot Floors only where the collection ships it", () => {
    const page = read("app/(collections)/[collection]/sniper/page.tsx")
    expect(page).toContain('collectionHasPage(collection, "hot-floors")')
  })
})
