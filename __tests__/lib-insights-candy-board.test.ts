import { describe, it, expect, vi } from "vitest"

// board-status is pure; import the real thing so degraded summarization is exercised.
import { fetchCandyMlbDefault } from "@/lib/insights/candy-board"

// Query-builder fake: from(table) → chainable; terminal .limit() resolves to the
// per-table result. Covers both candy-board chains: .select().order().limit() and
// .select().limit(1).
function fakeDb(byTable: Record<string, { data: any; error: any }>) {
  const make = (table: string) => {
    const res = byTable[table] ?? { data: [], error: null }
    const qb: any = {
      select: () => qb,
      order: () => qb,
      limit: () => Promise.resolve(res),
    }
    return qb
  }
  return { from: (t: string) => make(t) } as any
}

const ALL_TABLES = [
  "candy_secondary_board",
  "candy_pack_ev_model",
  "candy_pack_market",
  "candy_deals_board",
  "candy_offer_spread_board",
  "candy_special_serials_board",
  "candy_scarcity_board",
  "candy_holder_board",
  "candy_player_board",
  "candy_parallel_premium",
]

function allOk(overrides: Record<string, { data: any; error: any }> = {}) {
  const base: Record<string, { data: any; error: any }> = {}
  for (const t of ALL_TABLES) base[t] = { data: [{ x: 1 }], error: null }
  return { ...base, ...overrides }
}

describe("fetchCandyMlbDefault", () => {
  it("assembles all 10 sections and is ok when every section succeeds", async () => {
    const res = await fetchCandyMlbDefault(fakeDb(allOk()))
    expect(res.ok).toBe(true)
    expect(res.rowCount).toBe(1) // market rows length
    const p = res.payload as any
    expect(Array.isArray(p.initialRows)).toBe(true)
    expect(p.packEv).toEqual({ x: 1 }) // single-row section → object, not array
    expect(p.packMarket).toEqual({ x: 1 })
    expect(Array.isArray(p.deals)).toBe(true)
    // a fully-healthy board has no degraded notice
    expect(p.degraded).toBeNull()
    expect(typeof p.fetchedAt).toBe("string")
  })

  it("is ok=false and reports the degraded section when one view errors", async () => {
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_scarcity_board: { data: null, error: { message: "timeout" } } }))
    )
    expect(res.ok).toBe(false)
    const p = res.payload as any
    // the payload still assembles (fail-soft [] for the bad section) and the degraded
    // roll-up names the failed section for honest rendering
    expect(p.scarcity).toEqual([])
    expect(p.degraded).not.toBeNull()
    expect(p.degraded.failed).toContain("Scarcity")
  })

  it("treats a single-row section that errors as not ok", async () => {
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_pack_market: { data: null, error: { message: "boom" } } }))
    )
    expect(res.ok).toBe(false)
    expect((res.payload as any).packMarket).toBeNull()
  })
})
