import { describe, it, expect } from "vitest"
import { fetchCandyConfirmedFloors, mergeCeilingAsks } from "@/lib/fmv-candy-ceiling"

// Pins lib/fmv-candy-ceiling.ts: the Candy confirmed ask that fmv-recalc's
// ask-ceiling reads. Route-level behaviour is pinned in
// api-fmv-recalc-deep-loop.test.ts; this file pins the read's own contract.

function fakeSupabase(pages: Array<{ data: unknown; error: unknown } | Error>) {
  const calls: Array<{ table: string; ids: string[]; gt: [string, number] | null }> = []
  let n = 0
  return {
    calls,
    from(table: string) {
      const call = { table, ids: [] as string[], gt: null as [string, number] | null }
      calls.push(call)
      const q = {
        select: () => q,
        in: (_c: string, ids: string[]) => ((call.ids = ids), q),
        gt: (c: string, v: number) => {
          call.gt = [c, v]
          const page = pages[n++] ?? { data: [], error: null }
          return page instanceof Error ? Promise.reject(page) : Promise.resolve(page)
        },
      }
      return q
    },
  }
}

describe("fetchCandyConfirmedFloors", () => {
  it("reads the CONFIRMED column of candy_listing_floor, chunked, keyed by edition", async () => {
    const sb = fakeSupabase([
      { data: [{ edition_id: "a", confirmed_floor_usd: "66.5" }], error: null },
      { data: [{ edition_id: "c", confirmed_floor_usd: 4 }], error: null },
    ])
    const r = await fetchCandyConfirmedFloors(sb, ["a", "b", "c"], 2)
    expect(sb.calls.map((c) => c.table)).toEqual(["candy_listing_floor", "candy_listing_floor"])
    expect(sb.calls.map((c) => c.ids)).toEqual([["a", "b"], ["c"]])
    // Never the unconfirmed floor_usd: a listing no longer seen must not cap.
    expect(sb.calls[0].gt).toEqual(["confirmed_floor_usd", 0])
    expect([...r.floors]).toEqual([["a", 66.5], ["c", 4]])
    expect(r.error).toBeNull()
  })

  it("drops non-positive and non-numeric asks", async () => {
    const sb = fakeSupabase([
      { data: [{ edition_id: "a", confirmed_floor_usd: null }, { edition_id: "b", confirmed_floor_usd: "x" }, { edition_id: "c", confirmed_floor_usd: 0 }], error: null },
    ])
    const r = await fetchCandyConfirmedFloors(sb, ["a", "b", "c"])
    expect(r.floors.size).toBe(0)
  })

  it("keeps the chunks that succeeded and REPORTS the one that failed (error or throw)", async () => {
    const sb = fakeSupabase([
      { data: null, error: { message: "timeout" } },
      { data: [{ edition_id: "c", confirmed_floor_usd: 5 }], error: null },
      new Error("socket hang up"),
    ])
    const r = await fetchCandyConfirmedFloors(sb, ["a", "b", "c", "d", "e"], 2)
    expect([...r.floors]).toEqual([["c", 5]])
    expect(r.error).toContain("socket hang up")
  })

  it("makes no read for an empty page", async () => {
    const sb = fakeSupabase([])
    const r = await fetchCandyConfirmedFloors(sb, [])
    expect(sb.calls).toHaveLength(0)
    expect(r).toEqual({ floors: new Map(), error: null })
  })
})

describe("mergeCeilingAsks", () => {
  it("keeps the LOWER ask on a collision and adds new editions", () => {
    const t = new Map([["a", 10], ["b", 3]])
    mergeCeilingAsks(t, new Map([["a", 4], ["b", 8], ["c", 1]]))
    expect([...t]).toEqual([["a", 4], ["b", 3], ["c", 1]])
  })
})
