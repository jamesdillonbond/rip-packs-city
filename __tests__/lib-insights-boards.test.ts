import { describe, it, expect } from "vitest"
import {
  fetchDealsDefault,
  fetchRookiesDefault,
  fetchFirstMintDefault,
} from "@/lib/insights/boards"

// Minimal query-builder fake: every chained method returns the same object and the
// terminal `.limit()` resolves to a per-table result. Mirrors the supabase-js shape
// the builders use (from → select → [gte/order] → limit → Promise<{data,error}>).
function fakeDb(byTable: Record<string, { data: any; error: any }>) {
  const make = (table: string) => {
    const res = byTable[table] ?? { data: [], error: null }
    const qb: any = {
      select: () => qb,
      gte: () => qb,
      order: () => qb,
      limit: () => Promise.resolve(res),
    }
    return qb
  }
  return { from: (t: string) => make(t) } as any
}

describe("fetchDealsDefault", () => {
  it("shapes the default payload and reports ok + rowCount", async () => {
    const db = fakeDb({
      cross_collection_deals_board: { data: [{ external_id: "a" }, { external_id: "b" }], error: null },
    })
    const res = await fetchDealsDefault(db)
    expect(res.ok).toBe(true)
    expect(res.rowCount).toBe(2)
    expect((res.payload.rows as any[]).length).toBe(2)
    expect(typeof res.payload.fetched_at).toBe("string")
  })

  it("reports ok=false on a backing-view error", async () => {
    const db = fakeDb({
      cross_collection_deals_board: { data: null, error: { message: "timeout" } },
    })
    const res = await fetchDealsDefault(db)
    expect(res.ok).toBe(false)
    expect(res.rowCount).toBe(0)
    expect(res.payload.rows).toEqual([])
  })
})

describe("fetchRookiesDefault", () => {
  it("shapes stats + rows and is ok only when both queries succeed", async () => {
    const db = fakeDb({
      topshot_2025_rookie_cohort_stats: { data: [{ total: 1 }], error: null },
      topshot_2025_rookie_index: { data: [{ player: "x" }], error: null },
    })
    const res = await fetchRookiesDefault(db)
    expect(res.ok).toBe(true)
    expect(res.payload.cohort_stats).toEqual({ total: 1 })
    expect((res.payload.rows as any[]).length).toBe(1)
  })

  it("is ok=false when either query errors", async () => {
    const db = fakeDb({
      topshot_2025_rookie_cohort_stats: { data: [{ total: 1 }], error: null },
      topshot_2025_rookie_index: { data: null, error: { message: "boom" } },
    })
    const res = await fetchRookiesDefault(db)
    expect(res.ok).toBe(false)
  })
})

describe("fetchFirstMintDefault", () => {
  it("shapes stats + trophies and reports rowCount from the trophies list", async () => {
    const db = fakeDb({
      topshot_first_mint_trophy_stats: { data: [{ n: 452 }], error: null },
      topshot_first_mint_trophies: { data: [{ edition_id: 1 }, { edition_id: 2 }, { edition_id: 3 }], error: null },
    })
    const res = await fetchFirstMintDefault(db)
    expect(res.ok).toBe(true)
    expect(res.rowCount).toBe(3)
    expect(res.payload.stats).toEqual({ n: 452 })
    expect((res.payload.trophies as any[]).length).toBe(3)
  })

  it("is ok=false when the stats query errors", async () => {
    const db = fakeDb({
      topshot_first_mint_trophy_stats: { data: null, error: { message: "x" } },
      topshot_first_mint_trophies: { data: [], error: null },
    })
    const res = await fetchFirstMintDefault(db)
    expect(res.ok).toBe(false)
  })
})
