import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * fetchAllDayHotFloors (All Day ↔ Top Shot parity, 2026-10-26): `ok` means the READ worked; a non-array
 * payload is a failure, not an empty market. Plus the page/registry wiring: All Day's `hot-floors`
 * permission is backed by an All Day arm that returns before the Top Shot Quick-Buy read.
 */

vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))

import { fetchAllDayHotFloors, ALLDAY_HOT_FLOORS_DAYS } from "@/lib/hot-floors/allday"
import { collectionHasPage } from "@/lib/collections"

const db = (res: unknown, calls: unknown[] = []) => ({
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

describe("fetchAllDayHotFloors", () => {
  it("reads get_allday_hot_floors over the All Day window", async () => {
    const calls: unknown[] = []
    const r = await fetchAllDayHotFloors(db({ data: { editions: [{ external_id: "3201" }], newest_sale_at: "2026-10-27T00:51:49Z" }, error: null }, calls))
    expect(calls).toEqual([["get_allday_hot_floors", { p_days: ALLDAY_HOT_FLOORS_DAYS }]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "3201" }], newestSaleAt: "2026-10-27T00:51:49Z" })
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
    expect((await fetchAllDayHotFloors({ rpc: () => Promise.reject(new Error("boom")) })).ok).toBe(false)
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
