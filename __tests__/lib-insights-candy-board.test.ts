import { describe, it, expect } from "vitest"

// board-status is pure; import the real thing so degraded summarization is exercised.
import { fetchCandyMlbDefault } from "@/lib/insights/candy-board"
import { HOLDERS_MAX_ROWS } from "@/lib/insights/candy-board-limits"

// Query-builder fake: from(table) → chainable; terminal .limit() resolves to the
// per-table result. Covers both candy-board chains: .select().order().limit() and
// .select().limit(1).
// `.eq()` is recorded: since 2026-11-08 the edition-grain views carry every Candy set
// and this Base Series board filters set_id.
const eqByTable: Record<string, Array<[string, unknown]>> = {}
function fakeDb(byTable: Record<string, { data: any; error: any }>) {
  const make = (table: string) => {
    const res = byTable[table] ?? { data: [], error: null }
    const qb: any = {
      select: () => qb,
      eq: (c: string, v: unknown) => { (eqByTable[table] ??= []).push([c, v]); return qb },
      order: () => qb,
      // Honour the limit AND PostgREST's 1,000-row clamp, so a test can tell a
      // single capped read from a paged one.
      limit: (n: number) =>
        Promise.resolve(
          res.error ? res : { data: (res.data ?? []).slice(0, Math.min(n, 1000)), error: null }
        ),
      // Paged reads (Holders) end in .range(from, to): slice the per-table rows so a
      // fixture longer than one page exercises the page loop.
      range: (from: number, to: number) =>
        Promise.resolve(
          res.error ? res : { data: (res.data ?? []).slice(from, Math.min(to + 1, from + 1000)), error: null }
        ),
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

  it("stays ok=true when a PERIPHERAL view errors, but reports it as degraded", async () => {
    // Market-gated: a peripheral (Scarcity) failure does not block caching; the
    // degraded roll-up keeps the served board honest.
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_scarcity_board: { data: null, error: { message: "timeout" } } }))
    )
    expect(res.ok).toBe(true)
    const p = res.payload as any
    expect(p.scarcity).toEqual([]) // fail-soft [] for the bad section
    expect(p.degraded).not.toBeNull()
    expect(p.degraded.failed).toContain("Scarcity")
  })

  it("is ok=false ONLY when the primary Market section errors", async () => {
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_secondary_board: { data: null, error: { message: "boom" } } }))
    )
    expect(res.ok).toBe(false)
    const p = res.payload as any
    expect(p.initialRows).toEqual([])
    expect(p.degraded.failed).toContain("Market")
  })

  it("a peripheral single-row section erroring is degraded but still ok", async () => {
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_pack_market: { data: null, error: { message: "boom" } } }))
    )
    expect(res.ok).toBe(true)
    expect((res.payload as any).packMarket).toBeNull()
    expect((res.payload as any).degraded.failed).toContain("Pack market")
  })
})

// Each candy section is an ORDERED view read with a hard `.limit()`. Filling that
// limit exactly is a TRUNCATED RANKING served as the complete set: nothing errors,
// every row on screen is correct, the board just stops. Measured 2026-08-12,
// candy_special_serials_board sits at 607 rows against a cap of 800 and
// candy_holder_board at 395 against 600 — both growing with each Candy drop.
describe("fetchCandyMlbDefault — row-cap truncation", () => {
  it("discloses a section that filled its cap, and names it in telemetry", async () => {
    // serials cap is 800; hand back exactly 800 rows.
    const full = Array.from({ length: 800 }, (_, i) => ({ x: i }))
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_special_serials_board: { data: full, error: null } }))
    )
    const p = res.payload as any
    expect(p.degraded, "a capped section must produce a notice").not.toBeNull()
    expect(p.degraded.truncated).toContain("Serials")
    // ...and the telemetry must say WHICH kind of failure it was, because a dead
    // view and a filled cap need opposite responses.
    expect(res.error).toContain("Serials")
    expect(res.error).toContain("row cap")
  })

  it("does NOT flag a section that came back under its cap", async () => {
    const res = await fetchCandyMlbDefault(fakeDb(allOk()))
    const p = res.payload as any
    expect(p.degraded).toBeNull()
    expect(res.error).toBeUndefined()
  })

  it("keeps serving the truncated slice — disclosure, not blanking", async () => {
    // Unlike panini's ranking (emptied on truncation), a large top-N candy slice is
    // still useful; blanking a tab because it filled its cap would be a far bigger
    // behaviour change than the problem. The rows must survive.
    // Serials is read with limit 800, NOT the 600 default — the call sites differ.
    // (Re-pinned 2026-11-15: this used Holders, which is now PAGED — see below.)
    const full = Array.from({ length: 800 }, (_, i) => ({ x: i }))
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_special_serials_board: { data: full, error: null } }))
    )
    const p = res.payload as any
    expect(p.serials.length).toBe(800)
    expect(p.degraded.truncated).toContain("Serials")
    // The cache gate stays on Market alone — a capped Holders tab must not stop the
    // whole board being warmed.
    expect(res.ok).toBe(true)
  })
})

describe("fetchCandyMlbDefault — Base Series only (2026-11-08)", () => {
  it("filters every edition-grain section to the Base set; collection-wide models are left alone", async () => {
    for (const k of Object.keys(eqByTable)) delete eqByTable[k]
    await fetchCandyMlbDefault(fakeDb(allOk()))
    const BASE = "381ae129-7dc7-47f4-9022-dd9e0fc21e39"
    for (const t of ["candy_secondary_board", "candy_deals_board", "candy_offer_spread_board", "candy_special_serials_board"]) {
      expect(eqByTable[t], t).toContainEqual(["set_id", BASE])
    }
    // Already Base-scoped in their views (or wallet-grain): no extra filter.
    for (const t of ["candy_scarcity_board", "candy_player_board", "candy_holder_board"]) {
      expect(eqByTable[t] ?? []).toEqual([])
    }
  })
})

// Holders passed PostgREST's 1,000-row clamp (1,316 on 2026-11-15). The section is
// now read in pages, so every holder reaches the payload and no cap notice shows.
describe("fetchCandyMlbDefault — paged Holders read", () => {
  it("returns every holder past 1,000 with no cap notice", async () => {
    const many = Array.from({ length: 1316 }, (_, i) => ({ wallet_address: `w${i}`, serials: 1316 - i }))
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_holder_board: { data: many, error: null } }))
    )
    const p = res.payload as any
    expect(p.holders).toHaveLength(1316)
    expect(new Set(p.holders.map((h: any) => h.wallet_address)).size).toBe(1316)
    expect(p.degraded).toBeNull()
  })

  it("discloses Holders only when the paged read fills its ceiling", async () => {
    const full = Array.from({ length: HOLDERS_MAX_ROWS + 5 }, (_, i) => ({ wallet_address: `w${i}` }))
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_holder_board: { data: full, error: null } }))
    )
    const p = res.payload as any
    expect(p.holders).toHaveLength(HOLDERS_MAX_ROWS)
    expect(p.degraded.truncated).toContain("Holders")
    expect(res.ok).toBe(true)
  })

  it("a failed page fails the section: no partial list served as complete", async () => {
    const res = await fetchCandyMlbDefault(
      fakeDb(allOk({ candy_holder_board: { data: null, error: { message: "timeout" } } }))
    )
    const p = res.payload as any
    expect(p.holders).toEqual([])
    expect(p.degraded.failed).toContain("Holders")
  })
})
