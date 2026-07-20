import { describe, it, expect, vi } from "vitest"
import { fetchAllPaged } from "@/lib/supabase-paginate"

// Fake page source: returns `total` rows in pages, recording the ranges asked for.
function source(total: number, pageSize = 1000) {
  const calls: Array<[number, number]> = []
  const fn = async (from: number, to: number) => {
    calls.push([from, to])
    const rows = []
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ i })
    return { data: rows, error: null }
  }
  return { fn, calls, pageSize }
}

describe("fetchAllPaged", () => {
  it("returns every row when the set exceeds the 1,000-row PostgREST cap", async () => {
    const s = source(1233)
    const r = await fetchAllPaged<{ i: number }>(s.fn)
    // The whole point: 1,233 rows, not the 1,000 a .limit() would have silently given.
    expect(r.rows).toHaveLength(1233)
    expect(r.truncated).toBe(false)
    expect(r.error).toBeNull()
    expect(r.rows[0].i).toBe(0)
    expect(r.rows[1232].i).toBe(1232)
    expect(s.calls).toEqual([[0, 999], [1000, 1999]])
  })

  it("stops after one page when the first page is short", async () => {
    const s = source(42)
    const r = await fetchAllPaged<{ i: number }>(s.fn)
    expect(r.rows).toHaveLength(42)
    expect(r.truncated).toBe(false)
    expect(s.calls).toHaveLength(1)
  })

  it("does an extra probe page when the total is an exact multiple of pageSize", async () => {
    // 2,000 rows: page 2 comes back empty, which is the only end signal available.
    const s = source(2000)
    const r = await fetchAllPaged<{ i: number }>(s.fn)
    expect(r.rows).toHaveLength(2000)
    expect(r.truncated).toBe(false)
    expect(s.calls).toHaveLength(3)
  })

  it("caps pageSize at 1,000 so a larger request cannot be clamped into a false short-page", async () => {
    const s = source(1500)
    const r = await fetchAllPaged<{ i: number }>(s.fn, { pageSize: 5000 })
    expect(s.calls[0]).toEqual([0, 999])
    expect(r.rows).toHaveLength(1500)
  })

  it("flags truncated (never throws) when a page errors, keeping rows already read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    let n = 0
    const r = await fetchAllPaged<{ i: number }>(async (from, to) => {
      if (n++ === 1) return { data: null, error: { message: "boom" } }
      const rows = []
      for (let i = from; i <= to; i++) rows.push({ i })
      return { data: rows, error: null }
    }, { label: "t" })
    expect(r.rows).toHaveLength(1000)
    expect(r.truncated).toBe(true)
    expect(r.error).toBe("boom")
    spy.mockRestore()
  })

  it("flags truncated when maxPages is hit, so a partial total is never read as complete", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const s = source(10_000)
    const r = await fetchAllPaged<{ i: number }>(s.fn, { maxPages: 2, label: "t" })
    expect(r.rows).toHaveLength(2000)
    expect(r.truncated).toBe(true)
    expect(r.error).toBeNull()
    spy.mockRestore()
  })
})
