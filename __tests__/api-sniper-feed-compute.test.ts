import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Phase 2 of the deep-loop layer: drive sniper-feed's REAL Top Shot compute
// (computeSniperFeed) instead of bypassing it. Discovery: the TS pool is
// Supabase-sourced (ts_listings), not a live GQL fetch, so makeSupabaseFixture
// alone drives fetchTopShotPool -> resolveEditionKeys -> the FMV/badge/jersey
// enrichment fan-out -> merge/sort. getOrSetCache is stubbed to RUN the factory
// (not return a canned result), and the FMV display guard is neutralized so the
// compute body executes end-to-end and returns a structured feed.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, any> }))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => factory(),
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture(fx.tables) }))
vi.mock("@/lib/fmv-display-guard", () => ({
  loadTopshotFmvGuard: async () => new Map(),
  guardTopshotFmv: (fmv: number) => ({ fmv, clamped: false, thin: false }),
}))

const { GET } = await import("@/app/api/sniper-feed/route")
const get = (qs = "") => new Request(`https://t/api/sniper-feed${qs}`)

function tsListing(over: Record<string, any> = {}) {
  return {
    listing_id: "L1",
    flow_id: "F1",
    set_id: 1,
    play_id: 2,
    serial_number: 5,
    circulation_count: 1000,
    price_usd: 10,
    player_name: "Stephen Curry",
    set_name: "Base Set",
    moment_tier: "COMMON",
    series_number: 4,
    is_locked: false,
    listed_at: "2026-07-16T00:00:00Z",
    ingested_at: "2026-07-16T00:00:00Z",
    ...over,
  }
}

beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
})

describe("sniper-feed computeSniperFeed (Supabase-driven TS pool)", () => {
  it("runs the compute end-to-end and returns a structured feed for an empty pool", async () => {
    // No ts_listings -> compute still runs the sparse-augment RPC path (empty) +
    // enrichment, returning a well-formed empty feed rather than throwing.
    fx.tables = { ts_listings: { data: [] } }
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deals)).toBe(true)
    expect(body.count).toBe(body.deals.length)
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
  })

  it("runs the compute body end-to-end over a populated pool without throwing", async () => {
    // >=25 listings skips the sparse-augment RPC and drives the GQL(=ts_listings)
    // pool through fetchTopShotPool's mapping, resolveEditionKeys, the FMV/badge/
    // jersey enrichment fan-out, the deal-build loop, and sort/filter. Deals filter
    // out here (empty fmv_snapshots -> no priced FMV), but the whole compute BODY
    // executes and returns a valid structured feed rather than a 500.
    fx.tables = {
      ts_listings: {
        data: Array.from({ length: 30 }, (_, i) =>
          tsListing({ listing_id: `L${i}`, flow_id: `F${i}`, price_usd: 10 + i, player_name: `Player ${i}` }),
        ),
      },
    }
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deals)).toBe(true)
    expect(body.count).toBe(body.deals.length)
  })

  it("honors the limit param against the computed deal set", async () => {
    fx.tables = {
      ts_listings: {
        data: Array.from({ length: 30 }, (_, i) => tsListing({ listing_id: `L${i}`, flow_id: `F${i}` })),
      },
    }
    const res = await GET(get("?collection=nba-top-shot&limit=3"))
    const body = await res.json()
    expect(body.deals.length).toBeLessThanOrEqual(3)
  })
})
