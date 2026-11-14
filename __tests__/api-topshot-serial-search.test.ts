import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/topshot-serial-search — feedback #12359. Contracts pinned:
//   - serial is validated (1–99,999 integer); bad input is a 400 that calls nothing;
//   - a failed RPC (or an envelope with no counts) is a 5xx, never `rows: []`;
//   - coverage passes through unchanged, so the UI's coverage line is the DB's count;
//   - maxPrice / tier reach the RPC; "all" means no tier filter.

const state = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  result: { data: null, error: null } as { data: unknown; error: { message: string } | null },
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, args })
      return Promise.resolve(state.result)
    },
  },
}))

const { GET } = await import("@/app/api/topshot-serial-search/route")
const req = (qs: string) => new NextRequest(`https://t/api/topshot-serial-search?${qs}`)

const COVERAGE = {
  serial: 23, confirmed_count: 2, confirmed_24h: 1, confirmed_verified: 1, unconfirmed_count: 358,
  editions_with_listing: 700, editions_verified_7d: 330, returned_confirmed: 2, returned_unconfirmed: 1,
  window_hours: 24, verify_days: 7, lookback_days: 60,
}

beforeEach(() => {
  state.calls = []
  state.result = { data: null, error: null }
})

describe("GET /api/topshot-serial-search", () => {
  it("rejects a missing, zero, fractional or out-of-range serial without calling the DB", async () => {
    for (const qs of ["", "serial=0", "serial=2.5", "serial=100000", "serial=abc", "serial=23&tier=mythic", "serial=23&maxPrice=-1"]) {
      expect((await GET(req(qs))).status, qs).toBe(400)
    }
    expect(state.calls).toHaveLength(0)
  })

  it("passes coverage and rows through, with filters reaching the RPC", async () => {
    state.result = {
      data: {
        coverage: COVERAGE,
        rows: [
          { nft_id: "1", price_usd: "5.00", serial_number: 23, confirmation: "confirmed_24h", player_name: "A", fmv_usd: "7.5" },
          { nft_id: "2", price_usd: "6.00", serial_number: 23, confirmation: "confirmed_verified", player_name: "B", fmv_usd: null },
          { nft_id: "3", price_usd: "1.00", serial_number: 23, confirmation: "unconfirmed", player_name: "C" },
        ],
      },
      error: null,
    }
    const res = await GET(req("serial=23&maxPrice=50&tier=rare"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(state.calls).toEqual([
      { fn: "get_topshot_listings_by_serial", args: { p_serial: 23, p_max_price_usd: 50, p_tier: "RARE", p_limit: 500 } },
    ])
    expect(body.coverage).toEqual(COVERAGE)
    expect(body.rows.map((r: { confirmation: string }) => r.confirmation)).toEqual(["confirmed_24h", "confirmed_verified", "unconfirmed"])
    expect(body.rows[0]).toMatchObject({ price_usd: 5, fmv_usd: 7.5 })
    expect(body.rows[1].fmv_usd).toBeNull()
    expect(res.headers.get("cache-control")).toContain("s-maxage=60")
  })

  it("tier=all is no filter", async () => {
    state.result = { data: { coverage: COVERAGE, rows: [] }, error: null }
    await GET(req("serial=23&tier=all"))
    expect(state.calls[0].args.p_tier).toBeNull()
  })

  it("a failed RPC is a 5xx, never rows: []", async () => {
    state.result = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("serial=23"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(body.coverage).toBeUndefined()
  })

  it("an envelope without counts is a 5xx, never a 'none listed'", async () => {
    state.result = { data: { rows: [], coverage: {} }, error: null }
    expect((await GET(req("serial=23"))).status).toBeGreaterThanOrEqual(500)
    state.result = { data: null, error: null }
    expect((await GET(req("serial=23"))).status).toBeGreaterThanOrEqual(500)
  })

  it("an honest empty read returns a measured zero", async () => {
    state.result = { data: { coverage: { ...COVERAGE, confirmed_count: 0, unconfirmed_count: 0 }, rows: [] }, error: null }
    const body = await (await GET(req("serial=99999"))).json()
    expect(body.coverage.confirmed_count).toBe(0)
    expect(body.rows).toEqual([])
  })
})
