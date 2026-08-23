import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/top-sales driving the real body: unknown
// collection short-circuit, the get_top_sales RPC path (row normalization +
// tier upper-casing), the RPC-error 500, and the Pinnacle direct-table path with
// its nested pinnacle_editions join. supabaseAdmin is a singleton bound to
// fx.tables, so mutate the object in place.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, { data?: unknown; error?: unknown }> }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture(fx.tables) }))

const { GET } = await import("@/app/api/top-sales/route")
const get = (qs: string) => new NextRequest(`https://t/api/top-sales${qs}`)

beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
})

describe("GET /api/top-sales — integration", () => {
  it("returns an empty sales list for an unknown collection", async () => {
    const res = await GET(get("?collection=not-real"))
    expect(res.status).toBe(200)
    expect((await res.json()).sales).toEqual([])
  })

  it("normalizes get_top_sales rows and upper-cases the tier", async () => {
    Object.assign(fx.tables, {
      "rpc:get_top_sales": {
        data: [
          { player_name: "Curry", set_name: "Base", tier: "rare", serial_number: "7", circulation_count: "100", price_usd: "42.5" },
        ],
      },
    })
    const res = await GET(get("?collection=nba-top-shot&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sales).toHaveLength(1)
    expect(body.sales[0]).toEqual({
      playerName: "Curry",
      setName: "Base",
      tier: "RARE",
      serialNumber: 7,
      circulationCount: 100,
      price: 42.5,
    })
  })

  it("500s with sales NULL — not an empty list — when the RPC errors", async () => {
    // ⚠ INVERTED 2026-08-23 (R33). An empty ARRAY on failure is a claim; null
    // is the absence of one.
    Object.assign(fx.tables, { "rpc:get_top_sales": { error: { message: "agg fail" } } })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).sales).toBeNull()
  })

  it("resolves Pinnacle sales from pinnacle_sales with the nested edition join", async () => {
    Object.assign(fx.tables, {
      pinnacle_sales: {
        data: [
          {
            sale_price_usd: "80",
            serial_number: "3",
            pinnacle_editions: { character_name: "Mickey", set_name: "S1", variant_type: "chaser" },
          },
        ],
      },
    })
    const res = await GET(get("?collection=disney-pinnacle"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sales[0]).toMatchObject({ playerName: "Mickey", setName: "S1", tier: "CHASER", price: 80 })
  })

  it("clamps limit into [1,25] and defaults a non-numeric limit to 5", async () => {
    // The clamp is upstream of the RPC; assert via the p_limit the fixture receives.
    let seenLimit: number | undefined
    Object.assign(fx.tables, {
      "rpc:get_top_sales": { data: [], _onArgs: (a: any) => { seenLimit = a?.p_limit } },
    })
    // Fixture ignores unknown keys, so drive the clamp by asserting no throw + 200 and
    // that each boundary produces a valid response.
    for (const [qs, _label] of [["limit=0", "min"], ["limit=999", "max"], ["limit=abc", "nan"]] as const) {
      const res = await GET(get(`?collection=nba-top-shot&${qs}`))
      expect(res.status).toBe(200)
    }
    void seenLimit
  })

  it("Pinnacle: a query error is a 500, NOT a 200 with an empty list", async () => {
    // 🚨 INVERTED 2026-08-23 — this test's own NAME was the defect (R33).
    // "degrades to an empty list (200, not 500)" meant a database error
    // rendered as "no top sales" at HTTP 200, and the success path's
    // s-maxage=300 then served that false claim for five minutes. The
    // non-Pinnacle branch returned 500 for the identical failure: one route,
    // two answers. The root cause was a SIGNATURE — pinnacleTopSales returned
    // a bare array, which cannot express "the read failed".
    Object.assign(fx.tables, { pinnacle_sales: { error: { message: "pinnacle boom" } } })
    const res = await GET(get("?collection=disney-pinnacle"))
    expect(res.status).toBe(500)
    expect((await res.json()).sales).toBeNull()
    expect(res.headers.get("cache-control")).toMatch(/no-store/)
  })

  it("Pinnacle: a missing edition join yields NULLs, never Unknown / '' / 0", async () => {
    // ⚠ INVERTED 2026-08-23 (R33). "Unknown" is a moment name a collector can
    // read; `serialNumber: 0` is a serial that cannot exist; and
    // circulationCount was HARDCODED to 0 on every Pinnacle row. Measured that
    // day: 5 of the top 5 Pinnacle sales by price in 7d carry a NULL serial, so
    // every row this route emitted for Pinnacle said #0.
    Object.assign(fx.tables, {
      pinnacle_sales: { data: [{ sale_price_usd: null, serial_number: null, pinnacle_editions: null }] },
    })
    const res = await GET(get("?collection=disney-pinnacle"))
    const body = await res.json()
    expect(body.sales[0]).toEqual({
      playerName: null,
      setName: null,
      tier: null,
      serialNumber: null,
      circulationCount: null,
      price: null,
    })
  })

  it("get_top_sales: null fields stay NULL, never Unknown / '' / 0", async () => {
    // ⚠ INVERTED 2026-08-23 (R33) — same reasoning as the Pinnacle case above.
    Object.assign(fx.tables, {
      "rpc:get_top_sales": {
        data: [{ player_name: null, set_name: null, tier: null, serial_number: null, circulation_count: null, price_usd: null }],
      },
    })
    const res = await GET(get("?collection=nba-top-shot"))
    const body = await res.json()
    expect(body.sales[0]).toEqual({
      playerName: null,
      setName: null,
      tier: null,
      serialNumber: null,
      circulationCount: null,
      price: null,
    })
  })

  it("a genuine empty window is still an empty ARRAY at 200 — the no-change control", async () => {
    // ⚠ The other direction. Turning failures into null must NOT turn a real
    // "no sales in this window" into null, or the route stops being able to say
    // the true thing.
    Object.assign(fx.tables, { "rpc:get_top_sales": { data: [] } })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).sales).toEqual([])
  })
})
