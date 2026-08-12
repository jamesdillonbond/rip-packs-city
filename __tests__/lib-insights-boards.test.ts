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

// The reason a board declined to warm is the only diagnostic the cron records.
// Before 2026-08-12 these fetchers reduced a PostgrestError to `ok: !error` and
// discarded it, so pipeline_runs read "deals; first-mint; panini-squeeze" — the
// keys, with no cause — for boards failing 80%+ of the time. These pin that the
// reason survives, AND that it names WHICH backing query failed, which is the whole
// value on a board that runs several.
describe("failed fetches report a usable reason", () => {
  it("deals names its backing view and the driver text", async () => {
    const db = fakeDb({
      cross_collection_deals_board: {
        data: null,
        error: { message: "canceling statement due to statement timeout" },
      },
    })
    const res = await fetchDealsDefault(db)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("cross_collection_deals_board")
    expect(res.error).toContain("canceling statement due to statement timeout")
  })

  it("first-mint distinguishes WHICH of its two queries failed", async () => {
    const db = fakeDb({
      topshot_first_mint_trophy_stats: { data: null, error: { message: "stats blew up" } },
      topshot_first_mint_trophies: { data: [{ external_id: "x" }], error: null },
    })
    const res = await fetchFirstMintDefault(db)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("topshot_first_mint_trophy_stats")
    // The query that WORKED must not be blamed — that is the point of naming them.
    expect(res.error).not.toContain("topshot_first_mint_trophies:")
  })

  it("rookies reports both when both fail", async () => {
    const db = fakeDb({
      topshot_2025_rookie_cohort_stats: { data: null, error: { message: "a" } },
      topshot_2025_rookie_index: { data: null, error: { message: "b" } },
    })
    const res = await fetchRookiesDefault(db)
    expect(res.ok).toBe(false)
    expect(res.error).toContain("topshot_2025_rookie_cohort_stats")
    expect(res.error).toContain("topshot_2025_rookie_index")
  })

  it("a healthy fetch carries no reason at all", async () => {
    const db = fakeDb({
      cross_collection_deals_board: { data: [{ external_id: "a" }], error: null },
    })
    const res = await fetchDealsDefault(db)
    expect(res.ok).toBe(true)
    expect(res.error).toBeUndefined()
  })
})
