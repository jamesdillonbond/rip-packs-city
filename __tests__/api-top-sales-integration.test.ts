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

  it("500s with an empty list when the RPC errors", async () => {
    Object.assign(fx.tables, { "rpc:get_top_sales": { error: { message: "agg fail" } } })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).sales).toEqual([])
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
})
