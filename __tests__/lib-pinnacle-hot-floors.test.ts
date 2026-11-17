import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * fetchPinnacleHotFloors (Disney Pinnacle ↔ Top Shot parity, pass 3, 2026-10-26): `ok` means the READ
 * worked; a non-array payload is a failure, not an empty market. Plus the page/registry wiring: Pinnacle's
 * `hot-floors` permission is backed by a Pinnacle arm that returns before the Top Shot Quick-Buy read.
 */

vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))

import { fetchPinnacleHotFloors, PINNACLE_HOT_FLOORS_DAYS } from "@/lib/hot-floors/pinnacle"
import { collectionHasPage } from "@/lib/collections"

const db = (res: unknown, calls: unknown[] = []) => ({
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")

describe("fetchPinnacleHotFloors", () => {
  it("reads get_pinnacle_hot_floors over the Pinnacle window", async () => {
    const calls: unknown[] = []
    const r = await fetchPinnacleHotFloors(db({ data: { editions: [{ external_id: "OEV2-ALIN-CRIM-S3" }], newest_sale_at: "2026-10-27T03:43:24Z" }, error: null }, calls))
    expect(calls).toEqual([["get_pinnacle_hot_floors", { p_days: PINNACLE_HOT_FLOORS_DAYS }]])
    expect(r).toEqual({ ok: true, editions: [{ external_id: "OEV2-ALIN-CRIM-S3" }], newestSaleAt: "2026-10-27T03:43:24Z" })
  })
  it("an empty list is a real, ok answer", async () => {
    const r = await fetchPinnacleHotFloors(db({ data: { editions: [] }, error: null }))
    expect(r).toEqual({ ok: true, editions: [], newestSaleAt: null })
  })
  it("an error, a missing list or a non-array is a failed read", async () => {
    expect((await fetchPinnacleHotFloors(db({ data: null, error: { message: "x" } }))).ok).toBe(false)
    expect((await fetchPinnacleHotFloors(db({ data: {}, error: null }))).ok).toBe(false)
    expect((await fetchPinnacleHotFloors(db({ data: { editions: "nope" }, error: null }))).ok).toBe(false)
  })
  it("a thrown read is a failed read", async () => {
    expect((await fetchPinnacleHotFloors({ rpc: () => Promise.reject(new Error("boom")) })).ok).toBe(false)
  })
})

describe("Pinnacle hot-floors wiring", () => {
  it("the registry ships hot-floors for Disney Pinnacle", () => {
    expect(collectionHasPage("disney-pinnacle", "hot-floors")).toBe(true)
  })
  it("the Pinnacle arm returns before the Top Shot-only branch and the Quick-Buy read", () => {
    const page = read("app/(collections)/[collection]/hot-floors/page.tsx")
    const arm = page.indexOf('collectionId === "disney-pinnacle"')
    expect(arm).toBeGreaterThan(-1)
    expect(arm).toBeLessThan(page.indexOf('collectionId !== "nba-top-shot"'))
    expect(arm).toBeLessThan(page.indexOf("await fetchHotFloors()"))
    expect(page).toContain("fetchPinnacleHotFloors()")
    expect(page).toContain("<PinnacleHotFloors")
    expect(read("lib/hot-floors/pinnacle.ts")).toContain('db.rpc("get_pinnacle_hot_floors"')
  })
})
