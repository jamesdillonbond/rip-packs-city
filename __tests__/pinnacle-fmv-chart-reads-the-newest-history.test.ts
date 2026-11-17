import { describe, it, expect } from "vitest"
import { load, newestHistoryAscending } from "@/lib/pinnacle/moment-detail"

// 2026-11-04: the pin page's FMV chart read `pinnacle_fmv_history` ascending with limit 400, so a pin
// past 400 rows (139 of 2,822 that day, max 426, growing daily) charted its OLDEST 400 and silently
// dropped every recent point. The read must take the NEWEST 400 and hand the chart ascending order.

const RENDER = "OEV1-SWHM-KYLO-S5"
const N = 426
const HISTORY = Array.from({ length: N }, (_, i) => ({
  computed_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
  fmv_usd: i, // the value IS the index, so the newest row is fmv N-1
  fmv_confidence: "MEDIUM",
  fmv_sales_count_30d: 1,
}))

/** A stub that, for pinnacle_fmv_history only, applies order() and limit() the way PostgREST does. */
function makeDb() {
  const build = (table: string) => {
    let asc = true
    let lim = Infinity
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "in", "not"]) b[m] = () => b
    b.order = (_col: string, opts?: { ascending?: boolean }) => { asc = opts?.ascending !== false; return b }
    b.limit = (n: number) => { lim = n; return b }
    const settle = () => {
      if (table === "pinnacle_catalog") return { data: { render_id: RENDER, edition_id: "2156", character_name: "Kylo Ren", set_name: "Star Wars", variant: "Standard", total_minted: 500, fmv_usd: 42, floor_ask: 50 }, error: null, count: null }
      if (table === "pinnacle_fmv_history") {
        const sorted = [...HISTORY].sort((a, z) => (asc ? 1 : -1) * (Date.parse(a.computed_at) - Date.parse(z.computed_at)))
        return { data: sorted.slice(0, lim), error: null, count: null }
      }
      if (table === "wallet_moments_cache") return { data: [], error: null, count: 3 }
      return { data: [], error: null, count: null }
    }
    b.maybeSingle = async () => settle()
    b.single = async () => settle()
    b.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(settle()).then(onF, onR)
    return b
  }
  return { from: (t: string) => build(t), rpc: async () => ({ data: null, error: null }) }
}

describe("the Pinnacle FMV chart reads the newest history, oldest-first", () => {
  it("a pin with 426 history rows charts the newest 400, ending at the latest point, ascending", async () => {
    const r = await load(RENDER, makeDb())
    expect(r.ok).toBe(true)
    const h = (r.data as { fmvHistory: Array<{ fmv_usd: number; computed_at: string }> }).fmvHistory
    expect(h).toHaveLength(400)
    expect(h[h.length - 1].fmv_usd).toBe(N - 1) // the newest point is present
    expect(h[0].fmv_usd).toBe(N - 400) // the 26 oldest are the ones dropped
    for (let i = 1; i < h.length; i++) expect(Date.parse(h[i].computed_at)).toBeGreaterThan(Date.parse(h[i - 1].computed_at))
  })

  it("newestHistoryAscending sorts by time and does not mutate its input", () => {
    const desc = [...HISTORY].reverse().slice(0, 3)
    const copy = desc.map((x) => ({ ...x }))
    const out = newestHistoryAscending(desc)
    expect(out.map((x) => x.fmv_usd)).toEqual([N - 3, N - 2, N - 1])
    expect(desc).toEqual(copy)
  })
})
