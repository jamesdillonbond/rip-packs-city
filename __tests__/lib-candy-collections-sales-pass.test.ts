import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/candy/collections-sales-pass.ts — the HOURLY sales-only pass over non-registry Candy
// collections (11-21: a $1,599 sale waited ~5 h for the rotating lane). Properties pinned:
// a new sale is offered to the drain queue with the rotating lane's reason; a sale already
// queued or in `sales` is not re-offered; the high-water mark moves only FORWARD, only behind a
// walk that reached it, and never behind an incomplete (page-capped) walk; the rotation stamp
// (market_checked_at) is never written; the active collections are walked first and a budget
// stop is REPORTED with the count it did not reach; a failed collection fails the run.

vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_UUID: "c1" }))
vi.mock("@/lib/chains/solana/das", () => ({ solUsd: async () => 150 }))

import { runCollectionsSalesPass, SALES_PASS_LIMIT, SALES_PASS_MAX_PAGES } from "@/lib/candy/collections-sales-pass"
import { QUEUE_REASON } from "@/lib/candy/collections-market"

const NOW = Date.parse("2026-11-21T22:30:00Z")
const sec = (iso: string) => Date.parse(iso) / 1000

const state: {
  queue: any[]
  orders: Array<{ col: string; opts: any }>
  updates: Array<{ address: string; patch: any; lt: any }>
  parks: any[]
  parkError: any
  queued: string[]
  sold: string[]
  me: Record<string, any[]>
  meCalls: string[]
  updateError: any
} = { queue: [], orders: [], updates: [], parks: [], parkError: null, queued: [], sold: [], me: {}, meCalls: [], updateError: null }

function db() {
  return {
    rpc: async (name: string, args: any) => {
      if (name === "candy_park_unresolved_sale") {
        if (state.parkError) return { data: null, error: state.parkError }
        state.parks.push(args)
      }
      return { data: null, error: null }
    },
    from: (table: string) => {
      const b: any = {
        _patch: null, _addr: null,
        select: () => b, neq: () => b, not: () => b,
        order: (col: string, opts: any) => { state.orders.push({ col, opts }); return b },
        eq: (_c: string, v: any) => { if (b._patch) b._addr = v; return b },
        lt: (_c: string, v: any) => {
          state.updates.push({ address: b._addr, patch: b._patch, lt: v })
          return Promise.resolve({ error: state.updateError })
        },
        limit: async () => ({ data: table === "candy_collections" ? state.queue : [], error: null }),
        in: (_c: string, vals: string[]) => {
          if (table === "candy_sales_unresolved") return Promise.resolve({ data: vals.filter((v) => state.queued.includes(v)).map((signature) => ({ signature })), error: null })
          if (table === "sales") return Promise.resolve({ data: vals.filter((v) => state.sold.includes(v)).map((transaction_hash) => ({ transaction_hash })), error: null })
          return b
        },
        update: (patch: any) => { b._patch = patch; return b },
      }
      return b
    },
  }
}

const fetchImpl = async (url: string) => {
  state.meCalls.push(url)
  const m = url.match(/collections\/([^/]+)\/activities\?offset=(\d+)&limit=(\d+)/)
  if (!m) return new Response("nf", { status: 404 })
  const all = state.me[m[1]] ?? []
  const off = Number(m[2]), lim = Number(m[3])
  return new Response(JSON.stringify(all.slice(off, off + lim)), { status: 200 })
}

const run = (budgetMs = 60_000, now = () => NOW) => runCollectionsSalesPass(db(), { budgetMs, now, fetchImpl: fetchImpl as any, pauseMs: 0 })
const sale = (sig: string, iso: string, price = 22.75) => ({ signature: sig, type: "buyNow", tokenMint: `M_${sig}`, blockTime: sec(iso), price, buyer: "B", seller: "S" })
const list = (iso: string) => ({ signature: `L_${iso}`, type: "list", tokenMint: "MX", blockTime: sec(iso) })

beforeEach(() => {
  state.queue = [
    { address: "A1", name: "2025 All-Star ICONS", me_symbol: "2025_allstar_icons", sales_high_water_at: "2026-11-20T23:26:16Z" },
  ]
  state.orders = []; state.updates = []; state.parks = []; state.parkError = null
  state.queued = []; state.sold = []; state.me = {}; state.meCalls = []; state.updateError = null
})

describe("runCollectionsSalesPass", () => {
  it("offers a sale newer than the high-water mark to the drain queue, and advances the mark forward only", async () => {
    state.me["2025_allstar_icons"] = [sale("SKENES", "2026-11-21T22:23:00Z"), list("2026-11-21T20:00:00Z"), sale("OLD", "2026-11-20T20:00:00Z")]
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.parks.map((p) => p.p_signature)).toEqual(["SKENES"])
    expect(state.parks[0]).toMatchObject({ p_skip_reason: QUEUE_REASON, p_price_sol: 22.75, p_token_mint: "M_SKENES" })
    expect(r.sales_offered).toBe(1)
    expect(state.updates).toEqual([{ address: "A1", patch: { sales_high_water_at: "2026-11-21T22:23:00.000Z" }, lt: "2026-11-21T22:23:00.000Z" }])
    // ONE small page, not the rotating lane's 500 × 31.
    expect(state.meCalls).toHaveLength(1)
    expect(state.meCalls[0]).toContain(`limit=${SALES_PASS_LIMIT}`)
  })

  it("never writes the rotating lane's market_checked_at (or anything but the high-water mark)", async () => {
    state.me["2025_allstar_icons"] = [sale("S1", "2026-11-21T22:00:00Z"), sale("OLD", "2026-11-19T00:00:00Z")]
    await run()
    for (const u of state.updates) expect(Object.keys(u.patch)).toEqual(["sales_high_water_at"])
  })

  it("does not re-offer a sale already queued or already in sales", async () => {
    state.me["2025_allstar_icons"] = [sale("Q", "2026-11-21T22:00:00Z"), sale("S", "2026-11-21T21:00:00Z"), sale("NEW", "2026-11-21T20:00:00Z"), sale("OLD", "2026-11-19T00:00:00Z")]
    state.queued = ["Q"]; state.sold = ["S"]
    const r = await run()
    expect(state.parks.map((p) => p.p_signature)).toEqual(["NEW"])
    expect(r.sales_seen).toBe(3)
    expect(r.sales_offered).toBe(1)
  })

  it("walks the most recently active collections first", async () => {
    await run()
    expect(state.orders[0]).toEqual({ col: "sales_high_water_at", opts: { ascending: false, nullsFirst: false } })
  })

  it("a walk that hits the page cap offers what it read but does NOT advance the mark (incomplete)", async () => {
    const busy = Array.from({ length: SALES_PASS_LIMIT * SALES_PASS_MAX_PAGES + 5 }, (_, i) => sale(`B${i}`, new Date(NOW - i * 1000).toISOString()))
    state.me["2025_allstar_icons"] = busy
    const r = await run()
    expect(state.meCalls).toHaveLength(SALES_PASS_MAX_PAGES)
    expect(r.incomplete).toBe(1)
    expect(r.sales_offered).toBe(SALES_PASS_LIMIT * SALES_PASS_MAX_PAGES)
    expect(state.updates).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("a failed offer fails the run and advances nothing", async () => {
    state.me["2025_allstar_icons"] = [sale("X", "2026-11-21T22:00:00Z"), sale("OLD", "2026-11-19T00:00:00Z")]
    state.parkError = { message: "permission denied" }
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.error).toContain("permission denied")
    expect(state.updates).toEqual([])
  })

  it("a failed high-water write fails the run, never reads as ok", async () => {
    state.me["2025_allstar_icons"] = [sale("X", "2026-11-21T22:00:00Z"), sale("OLD", "2026-11-19T00:00:00Z")]
    state.updateError = { message: "timeout" }
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.high_water_advanced).toBe(0)
  })

  it("a collection never walked by the rotating lane (no high-water mark) is skipped and counted", async () => {
    state.queue = [{ address: "N", name: "new", me_symbol: "new_sym", sales_high_water_at: null }]
    const r = await run()
    expect(r.skipped_no_high_water).toBe(1)
    expect(state.meCalls).toEqual([])
  })

  it("a budget stop is reported with how many collections it did not reach", async () => {
    state.queue = [
      { address: "A", name: "a", me_symbol: "a", sales_high_water_at: "2026-11-21T00:00:00Z" },
      { address: "B", name: "b", me_symbol: "b", sales_high_water_at: "2026-11-20T00:00:00Z" },
      { address: "C", name: "c", me_symbol: "c", sales_high_water_at: "2026-11-19T00:00:00Z" },
    ]
    let t = NOW
    const r = await runCollectionsSalesPass(db(), { budgetMs: 1500, now: () => (t += 1000), fetchImpl: fetchImpl as any, pauseMs: 0 })
    expect(r.budget_stopped).toBe(true)
    expect(r.checked + r.not_reached).toBe(3)
    expect(r.not_reached).toBeGreaterThan(0)
  })
})
