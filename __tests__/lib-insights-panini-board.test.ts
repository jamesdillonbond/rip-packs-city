import { describe, it, expect } from "vitest"
import { fetchPaniniSqueezeDefault } from "@/lib/insights/panini-board"

// Paginated query-builder fake. `panini_squeeze_board` is fetched via
// .from().select().not().order().range(from,to); we serve pages from a fixture list and
// can inject an error at a given page index to exercise the truncation gate. The two
// summary tables use .from().select().limit(1).
function fakeDb(opts: {
  boardPages?: any[][] // one array per .range() page
  boardErrorAtPage?: number // page index that returns an error
  coverage?: { data: any; error: any }
  totals?: { data: any; error: any }
}) {
  const boardPages = opts.boardPages ?? [[]]
  const make = (table: string) => {
    if (table === "panini_squeeze_board") {
      // Derive the page index from range()'s `from` offset so it is correct even though
      // fetchRows calls db.from() fresh on every page (which would reset a local counter).
      const qb: any = {
        select: () => qb,
        not: () => qb,
        order: () => qb,
        range: (from: number) => {
          const i = Math.floor(from / 1000)
          if (opts.boardErrorAtPage === i) {
            return Promise.resolve({ data: null, error: { message: "57014 timeout" } })
          }
          return Promise.resolve({ data: boardPages[i] ?? [], error: null })
        },
      }
      return qb
    }
    const res =
      table === "panini_coverage_summary"
        ? opts.coverage ?? { data: [{ total_editions: 10 }], error: null }
        : opts.totals ?? { data: [{ editions: 10 }], error: null }
    const qb: any = { select: () => qb, limit: () => Promise.resolve(res) }
    return qb
  }
  return { from: (t: string) => make(t) } as any
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ fmv_usd: 1000 - i }))

describe("fetchPaniniSqueezeDefault", () => {
  it("assembles a COMPLETE board (short final page) and is ok", async () => {
    // page 0 = 1000 rows, page 1 = 200 rows (short → stop). Complete.
    const res = await fetchPaniniSqueezeDefault(fakeDb({ boardPages: [rows(1000), rows(200)] }))
    expect(res.ok).toBe(true)
    expect(res.rowCount).toBe(1200)
    const p = res.payload as any
    expect(p.initialRows.length).toBe(1200)
    expect(p.coverage).toEqual({ total_editions: 10 })
    expect(p.totals).toEqual({ editions: 10 })
    expect(p.degraded).toBeNull() // complete → no notice
  })

  it("is NOT ok when a later page errors (truncated ranking must never be cached)", async () => {
    // page 0 ok (1000), page 1 errors → partial truncation.
    const res = await fetchPaniniSqueezeDefault(
      fakeDb({ boardPages: [rows(1000), rows(1000)], boardErrorAtPage: 1 })
    )
    expect(res.ok).toBe(false) // the whole point: a truncated ranking is not cacheable
    const p = res.payload as any
    // A truncated ranking is emptied, not rendered as if whole — the live-degraded
    // render path hands this payload back verbatim, so partial rows here would be a lie.
    expect(p.initialRows).toEqual([])
    expect(res.rowCount).toBe(1000) // telemetry still reports what was actually fetched
    expect(p.degraded).not.toBeNull() // ...and it still says it's degraded (truncated)
    expect(p.degraded.truncated).toContain("Squeeze board")
  })

  it("is NOT ok when the FIRST page errors (absent board)", async () => {
    const res = await fetchPaniniSqueezeDefault(
      fakeDb({ boardPages: [rows(1000)], boardErrorAtPage: 0 })
    )
    expect(res.ok).toBe(false)
    const p = res.payload as any
    expect(p.initialRows).toEqual([])
    expect(p.degraded.failed).toContain("Squeeze board")
  })

  it("stays ok with a complete board even if coverage/totals fall back to null", async () => {
    const res = await fetchPaniniSqueezeDefault(
      fakeDb({
        boardPages: [rows(50)],
        coverage: { data: null, error: { message: "x" } },
        totals: { data: null, error: { message: "y" } },
      })
    )
    expect(res.ok).toBe(true) // ranking is complete; summaries have their own fallbacks
    const p = res.payload as any
    expect(p.coverage).toBeNull()
    expect(p.totals).toBeNull()
  })
})
