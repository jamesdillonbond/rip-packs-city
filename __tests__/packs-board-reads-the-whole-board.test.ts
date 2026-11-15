import { describe, it, expect, vi } from "vitest"
import { fetchAllPackRows } from "@/lib/packs/fetch-all-pack-rows"

// 2026-11-14 (packs review): the Packs board fetched ONE page of 500 and sorted /
// filtered it as if it were the whole board (3,202 Top Shot packs that day).
describe("the Packs board reads every page", () => {
  const board = (n: number) => Array.from({ length: n }, (_, i) => ({ dist_id: i }))
  const server = (rows: { dist_id: number }[]) =>
    vi.fn(async (offset: number, limit: number) => ({ rows: rows.slice(offset, offset + limit), total: rows.length }))

  it("walks pages until it holds `total` rows — 3,202 packs, 4 requests", async () => {
    const fetchPage = server(board(3202))
    const out = await fetchAllPackRows(fetchPage)
    expect(out.rows).toHaveLength(3202)
    expect(out.total).toBe(3202)
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 1000, 2000, 3000])
  })
  it("a board that fits one page is one request", async () => {
    const fetchPage = server(board(166))
    expect((await fetchAllPackRows(fetchPage)).rows).toHaveLength(166)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
  it("a failed page fails the read — never a shorter board", async () => {
    let n = 0
    const fetchPage = async (offset: number, limit: number) => {
      if (++n === 2) throw new Error("Failed to load packs")
      return { rows: board(3202).slice(offset, offset + limit), total: 3202 }
    }
    await expect(fetchAllPackRows(fetchPage)).rejects.toThrow(/Failed to load packs/)
  })
  it("past the page ceiling it refuses instead of answering with what it has", async () => {
    await expect(fetchAllPackRows(server(board(50)), 10, 3)).rejects.toThrow(/Too many packs/)
  })
})

// The route must page with a UNIQUE tiebreak (most All Day packs share a NULL value_ratio).
describe("/api/packs pages with offset and a unique tiebreak", () => {
  it("orders by the sort column THEN dist_id, and maps offset/limit to range()", async () => {
    vi.resetModules()
    const calls: Array<[string, unknown[]]> = []
    vi.doMock("@supabase/supabase-js", () => {
      const b: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (res: (v: unknown) => void) => res({ data: [], count: 0, error: null })
          return (...args: unknown[]) => { calls.push([prop, args]); return b }
        },
      })
      return { createClient: () => ({ from: () => b }) }
    })
    const { GET } = await import("@/app/api/packs/route")
    await GET(new Request("http://x/api/packs?collection=nfl-all-day&limit=1000&offset=2000") as never)
    const orders = calls.filter(([p]) => p === "order").map(([, a]) => a[0])
    expect(orders.slice(0, 2)).toEqual(["value_ratio", "dist_id"])
    expect(calls.find(([p]) => p === "range")?.[1]).toEqual([2000, 2999])
  })
})
