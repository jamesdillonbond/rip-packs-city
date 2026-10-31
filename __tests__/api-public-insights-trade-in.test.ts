import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/public/insights/trade-in. The handler strips wildcards from
// the typed player, defaults the sort, clamps the limit NaN-safely, refuses a
// malformed wallet (never answers it with an empty portfolio), and maps a failed
// read to the shared 503 envelope with no driver text.

const state: { board: { data: any[] | null; error: any }; portfolio: { data: any[] | null; error: any }; throwErr: Error | null; lastOpts: any; lastWallet: any } = {
  board: { data: [], error: null },
  portfolio: { data: [], error: null },
  throwErr: null,
  lastOpts: null,
  lastWallet: null,
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))
vi.mock("@/lib/insights/trade-in-board", async (orig) => {
  const actual = await orig<typeof import("@/lib/insights/trade-in-board")>()
  return {
    ...actual,
    fetchTradeInBoard: async (_db: any, opts: any) => {
      state.lastOpts = opts
      if (state.throwErr) throw state.throwErr
      return state.board
    },
    fetchTradeInPortfolio: async (_db: any, wallet: string) => {
      state.lastWallet = wallet
      if (state.throwErr) throw state.throwErr
      return state.portfolio
    },
  }
})

import { GET } from "@/app/api/public/insights/trade-in/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/trade-in"

beforeEach(() => {
  state.board = { data: [], error: null }
  state.portfolio = { data: [], error: null }
  state.throwErr = null
  state.lastOpts = null
  state.lastWallet = null
})

describe("GET /api/public/insights/trade-in", () => {
  it("returns rows, states the rule, and echoes the cleaned filters", async () => {
    state.board = { data: [{ edition_id: "e1", external_id: "90:2968::2", asp: 5.26, low_ask: 0.35 }], error: null }
    const res = await GET(req(`${base}?player=%25jok_ic%25&sort=ratio&limit=25`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.source).toBe("v_insights_trade_in")
    expect(body.meta.asp_per_pack_usd).toBe(10)
    expect(body.meta.filters).toMatchObject({ player: "jokic", sort: "ratio", limit: 25 })
    expect(state.lastOpts).toMatchObject({ player: "jokic", sort: "ratio", limit: 25 })
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=3600")
  })

  it("defaults sort and limit (NaN-safe)", async () => {
    const res = await GET(req(`${base}?sort=bogus&limit=abc`))
    const body = await res.json()
    expect(body.meta.filters).toMatchObject({ player: null, sort: "cost", limit: 100 })
  })

  it("the wallet arm: a malformed address is refused, a good one is normalized and answered no-store", async () => {
    const bad = await GET(req(`${base}?wallet=not-a-wallet`))
    expect(bad.status).toBe(400)
    expect(state.lastWallet).toBeNull()
    state.portfolio = { data: [{ player_name: "LeBron James", moments: 92, moments_with_asp: 92, asp_total: 8116.59, packs: 811, to_next_pack: 3.41, total_players: 1332 }], error: null }
    const res = await GET(req(`${base}?wallet=0xBD94CADE097E50AC`))
    expect(res.status).toBe(200)
    expect(state.lastWallet).toBe("0xbd94cade097e50ac")
    const body = await res.json()
    expect(body.players).toHaveLength(1)
    expect(body.meta).toMatchObject({ wallet: "0xbd94cade097e50ac", shown: 1, total_players: 1332 })
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("a failed read is the board-unavailable envelope, never an empty board", async () => {
    state.board = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req(base))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("statement timeout")
  })

  it("a thrown read is the same envelope, on both arms", async () => {
    state.throwErr = new Error("pool exhausted")
    for (const u of [base, `${base}?wallet=0xbd94cade097e50ac`]) {
      const res = await GET(req(u))
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(JSON.stringify(await res.json())).not.toContain("pool exhausted")
    }
  })
})
