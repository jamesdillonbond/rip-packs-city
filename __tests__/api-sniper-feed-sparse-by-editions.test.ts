import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// The Top Shot pool is the newest 200 ts_listings rows by ingested_at — the last
// sync tick's batch — and one batch is a handful of moments listed many times.
// Measured in production logs, 2026-09-13 11:58–12:08 PT, sync tick down:
//   [sniper-feed] ts_listings: 200 rows, 0 edition keys resolved
//   [sniper-feed] built ts=0
//   [sniper-feed] DONE ts=0 total=0
// and the response was `count: 0, sourcesFailed: [], degraded: false` — an empty
// state that CONCLUDED, for hours, on the product's headline surface. The RPC
// augmentation that exists for a sparse pool never fired, because the gate
// counted ROWS (200 ≥ 25) and never EDITIONS (5).
//
// ⚠ Each case asserts what the route DOES with the RPC (called or not), not a
// log line, and the failure case asserts the ABSENCE of the false state.

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _t: number, fn: any) => fn(),
  deleteCache: () => {},
}))

const st = vi.hoisted(() => ({
  tsListings: { data: [] as any[], error: null as any },
}))
const rpc = vi.hoisted(() =>
  vi.fn<(name: string, params?: unknown) => Promise<any>>(async () => ({ data: [], error: null })),
)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b, gt: () => b, limit: () => b,
        range: () => b,
        then: (resolve: any) => {
          if (table === "ts_listings") return resolve(st.tsListings)
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

const TSQS = "?collection=nba-top-shot&minDiscount=0&maxPrice=100000&rarity=all&team=all"
const get = () => new Request(`https://t/api/sniper-feed${TSQS}`)

/** `rows` listings spread evenly over `editions` distinct (set_id, play_id) pairs. */
function pool(rows: number, editions: number) {
  return Array.from({ length: rows }, (_, i) => {
    const e = i % editions
    return {
      listing_id: `L${i}`,
      flow_id: `${100000 + i}`,
      set_id: 39,
      play_id: 1000 + e,
      parallel_id: 0,
      serial_number: i + 1,
      circulation_count: 4000,
      price_usd: 5,
      player_name: `Player ${e}`,
      set_name: "2021 NBA Playoffs",
      moment_tier: "COMMON",
      series_number: 2,
      is_locked: false,
      listed_at: "2026-09-13T17:55:00Z",
      ingested_at: "2026-09-13T17:55:00Z",
    }
  })
}

const rpcCalls = (name: string) => rpc.mock.calls.filter((c) => c[0] === name).length

beforeEach(() => {
  st.tsListings = { data: [], error: null }
  rpc.mockReset()
  rpc.mockImplementation(async () => ({ data: [], error: null }))
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ data: {} }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe("GET /api/sniper-feed — the Top Shot pool is sparse by EDITIONS, not by rows", () => {
  it("REPLAYS 2026-09-13: 200 rows over 5 editions augments with the edition-level RPC", async () => {
    st.tsListings = { data: pool(200, 5), error: null }
    await GET(get())
    expect(rpcCalls("get_topshot_sniper_deals")).toBe(1)
  })

  it("CONTROL: 200 rows over 40 editions is a real pool and does not augment", async () => {
    st.tsListings = { data: pool(200, 40), error: null }
    await GET(get())
    expect(rpcCalls("get_topshot_sniper_deals")).toBe(0)
  })

  it("the row-count gate still holds on its own: 10 rows over 10 editions augments", async () => {
    st.tsListings = { data: pool(10, 10), error: null }
    await GET(get())
    expect(rpcCalls("get_topshot_sniper_deals")).toBe(1)
  })

  it("⭐ when the pool is five editions AND the RPC fails, the board is DEGRADED — never a quiet floor", async () => {
    st.tsListings = { data: pool(200, 5), error: null }
    rpc.mockImplementation(async (name: string) =>
      name === "get_topshot_sniper_deals"
        ? { data: null, error: { message: "canceling statement due to statement timeout" } }
        : { data: [], error: null },
    )
    const body = await (await GET(get())).json()
    expect(body.sourcesFailed).toContain("topshot-deals-rpc")
    expect(body.degraded).toBe(true)
    // The state that shipped: count 0 with nothing failed.
    expect(!(body.count === 0 && body.degraded === false)).toBe(true)
  })
})
