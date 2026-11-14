import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/wallet-offers — the offers a wallet has made (Top Shot only).
// Contracts pinned:
//   - a collection without offer tracking answers supported:false and reads
//     NOTHING (never an empty list a card would render as "no offers");
//   - a failed status count is an ERROR response, never a measured 0;
//   - the happy path scopes every read by collection + offerer and returns
//     joined edition names with status totals.

const state = vi.hoisted(() => ({
  reads: [] as Array<{ table: string; filters: Array<[string, unknown[]]>; head: boolean }>,
  failCount: null as string | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: null, error: null } as { data: unknown; error: { message: string } | null },
}))

function builder(table: string) {
  const rec = { table, filters: [] as Array<[string, unknown[]]>, head: false }
  state.reads.push(rec)
  const resolve = () => {
    if (rec.head) {
      const status = rec.filters.find(([m, a]) => m === "eq" && a[0] === "status")?.[1][1] as string
      if (state.failCount === status) return { data: null, error: { message: "boom" }, count: null }
      return { data: null, error: null, count: { open: 2, filled: 5, cancelled: 9 }[status] ?? 0 }
    }
    return {
      data: [
        {
          offer_type: "edition",
          offer_amount_usd: "4.00",
          status: "filled",
          created_at: "2026-09-20T02:00:00Z",
          resolved_at: "2026-09-20T02:05:00Z",
          serial_number: null,
          editions: { player_name: "Damian Lillard", set_name: "Base Set", tier: "COMMON", external_id: "8:133" },
        },
      ],
      error: null,
    }
  }
  const b: Record<string, unknown> = {}
  b.select = (_c: string, opts?: { head?: boolean }) => { if (opts?.head) rec.head = true; return b }
  for (const m of ["eq", "order", "limit", "in"]) b[m] = (...a: unknown[]) => { rec.filters.push([m, a]); return b }
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad)
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      return Promise.resolve(state.rpcResult)
    },
  },
}))

const { GET } = await import("@/app/api/wallet-offers/route")

const W = "0xbd94cade097e50ac"
const req = (qs: string) => new NextRequest(`https://t/api/wallet-offers?${qs}`)

beforeEach(() => {
  state.reads = []
  state.failCount = null
  state.rpcCalls = []
  state.rpcResult = { data: null, error: null }
})

describe("GET /api/wallet-offers", () => {
  it("a collection without offer tracking answers supported:false and reads nothing", async () => {
    const res = await GET(req(`wallet=${W}&collection=nfl-all-day`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ supported: false, rows: [], summary: null })
    expect(state.reads).toHaveLength(0)
  })

  it("a failed status count is an error, never a measured zero", async () => {
    state.failCount = "open"
    const res = await GET(req(`wallet=${W}&collection=nba-top-shot`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.summary).toBeUndefined()
  })

  it("returns the wallet's offers scoped by collection + offerer, with totals", async () => {
    const res = await GET(req(`wallet=${W.toUpperCase().replace("0X", "0x")}&collection=nba-top-shot`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      supported: true,
      wallet: W,
      summary: { total: 16, open: 2, filled: 5, cancelled: 9 },
    })
    expect(body.rows[0]).toMatchObject({ player_name: "Damian Lillard", amount_usd: 4, status: "filled", offer_type: "edition" })
    expect(state.reads).toHaveLength(4)
    for (const r of state.reads) {
      expect(r.table).toBe("offers")
      expect(r.filters).toContainEqual(["eq", ["collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd"]])
      expect(r.filters).toContainEqual(["eq", ["buyer_address", W]])
    }
  })

  it("requires a wallet and a known collection", async () => {
    expect((await GET(req(`collection=nba-top-shot`))).status).toBe(400)
    expect((await GET(req(`wallet=${W}&collection=nope`))).status).toBe(400)
  })

  it("the default view never calls the open-offers RPC (unchanged response)", async () => {
    const res = await GET(req(`wallet=${W}&collection=nba-top-shot`))
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["collection", "rows", "summary", "supported", "tracked_since", "wallet"])
    expect(Object.keys(body.summary).sort()).toEqual(["cancelled", "filled", "open", "total"])
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("rejects an unknown view", async () => {
    expect((await GET(req(`wallet=${W}&collection=nba-top-shot&view=nope`))).status).toBe(400)
  })
})

describe("GET /api/wallet-offers?view=open", () => {
  const day = 86_400_000
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString()
  const row = (o: Record<string, unknown>) => ({
    offer_id: "1", offer_type: "edition", amount_usd: "5.00", created_at: iso(1), external_id: "8:133",
    player_name: "Damian Lillard", set_name: "Base Set", tier: "COMMON", parallel: null, serial_number: null,
    top_other_bid: null, own_higher_usd: null, floor_usd: null, floor_confirmed_at: null,
    serial_ask_usd: null, serial_ask_seen_at: null, age_days: "1.0", ...o,
  })

  it("calls the RPC with the normalized wallet and summarizes outbid / superseded / stale / at-floor", async () => {
    state.rpcResult = {
      data: [
        row({ offer_id: "a", top_other_bid: "6.00" }), // outbid
        row({ offer_id: "b", own_higher_usd: "9.00" }), // superseded by own
        row({ offer_id: "c", top_other_bid: "6.00", own_higher_usd: "9.00" }), // outbid wins
        row({ offer_id: "d", created_at: iso(20), floor_usd: "4.00" }), // stale + at/above floor
        row({ offer_id: "e", floor_usd: null }), // NULL floor: not at-floor, stays null
      ],
      error: null,
    }
    const res = await GET(req(`wallet=${W.toUpperCase().replace("0X", "0x")}&collection=nba-top-shot&view=open`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(state.rpcCalls).toEqual([{ fn: "get_topshot_wallet_open_offers", args: { p_wallet: W, p_limit: 500 } }])
    expect(body).toMatchObject({ supported: true, view: "open", wallet: W })
    // open is the MEASURED head count (2 in the mock), not rows.length (5)
    expect(body.summary).toEqual({ open: 2, shown: 5, truncated: false, outbid: 2, superseded: 1, stale: 1, at_or_above_floor: 1 })
    const by = Object.fromEntries(body.rows.map((r: { offer_id: string }) => [r.offer_id, r]))
    expect(by.a).toMatchObject({ outbid: true, superseded: false, top_other_bid: 6 })
    expect(by.b).toMatchObject({ outbid: false, superseded: true, own_higher_usd: 9 })
    expect(by.c).toMatchObject({ outbid: true, superseded: false })
    expect(by.d).toMatchObject({ stale: true, at_or_above_floor: true, floor_usd: 4 })
    expect(by.e.floor_usd).toBeNull()
    expect(by.e.at_or_above_floor).toBe(false)
  })

  it("says truncated when the measured open total exceeds the rows returned", async () => {
    state.rpcResult = { data: [row({ offer_id: "a" })], error: null }
    const body = await (await GET(req(`wallet=${W}&collection=nba-top-shot&view=open`))).json()
    expect(body.summary).toMatchObject({ open: 2, shown: 1, truncated: true })
  })

  it("a failed RPC is an error response, never rows: []", async () => {
    state.rpcResult = { data: null, error: { message: "boom" } }
    const res = await GET(req(`wallet=${W}&collection=nba-top-shot&view=open`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(body.summary).toBeUndefined()
  })

  it("a failed open count is an error, never a measured zero", async () => {
    state.rpcResult = { data: [], error: null }
    state.failCount = "open"
    const res = await GET(req(`wallet=${W}&collection=nba-top-shot&view=open`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).summary).toBeUndefined()
  })

  it("a collection without offer tracking answers supported:false and calls nothing", async () => {
    const res = await GET(req(`wallet=${W}&collection=nfl-all-day&view=open`))
    expect(await res.json()).toMatchObject({ supported: false, rows: [], summary: null })
    expect(state.rpcCalls).toHaveLength(0)
    expect(state.reads).toHaveLength(0)
  })
})
