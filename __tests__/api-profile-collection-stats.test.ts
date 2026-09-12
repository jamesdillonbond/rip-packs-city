import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/collection-stats.
//
// Public read (no auth). Requires ?wallet_addr → 400.
//
// ⭐ CACHE-FIRST since 2026-09-12. The route serves the precomputed
// `saved_wallets.cached_*` columns and only calls `get_wallet_collection_stats`
// when the wallet has no cached row yet. The reason is correctness, not speed:
// the live RPC carries `statement_timeout=20s` and its first CTE alone measures
// 43.5 s on a 19,520-Moment wallet, so production returned `503 stats_timeout`
// on EVERY call and the dashboard's only source of portfolio numbers was a route
// that always failed. The cached columns were correct the whole time — measured
// the same day, they matched `wallet_moments_cache` to within ~0.1%.
//
// The live path keeps its old contract: 57014 → 503 with retry, anything else
// → 500.

const rpc: { data: any; error: any; calls: number } = { data: [], error: null, calls: 0 }
const cache: { rows: any[] | null; error: any; throws: boolean } = { rows: null, error: null, throws: false }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      rpc.calls += 1
      return { data: rpc.data, error: rpc.error }
    },
    from: () => {
      if (cache.throws) throw new Error("cache read exploded")
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        // `.not("cache_updated_at", "is", null)` is the terminal call the route
        // awaits, so this is where the fixture is handed back.
        not: async () => ({ data: cache.rows, error: cache.error }),
      }
      return chain
    },
  },
}))

import { GET } from "@/app/api/profile/collection-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

const CACHED = (over: Record<string, unknown> = {}) => ({
  collection_id: "c1",
  cached_moment_count: 15335,
  cached_fmv_usd: 63007.85,
  cached_fmv_stale_usd: 4934.8,
  cached_stale_count: 7,
  cached_top_tier: "LEGENDARY",
  cache_updated_at: new Date(Date.now() - 3_600_000).toISOString(),
  collections: { slug: "nba_top_shot", name: "NBA Top Shot" },
  ...over,
})

beforeEach(() => {
  rpc.data = []
  rpc.error = null
  rpc.calls = 0
  cache.rows = null
  cache.error = null
  cache.throws = false
})

describe("GET /api/profile/collection-stats", () => {
  it("400s without wallet_addr", async () => {
    const res = await GET(req("https://t/api/profile/collection-stats"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet_addr required")
  })

  // ── the cached path ───────────────────────────────────────────────────────

  it("serves the precomputed columns and does NOT call the live RPC", async () => {
    cache.rows = [CACHED()]
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xABC"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe("cache")
    expect(body.wallet_addr).toBe("0xabc") // lower-cased
    expect(body.stats).toHaveLength(1)
    // ⚠ The whole point: the live RPC is the thing that times out. If this
    // assertion ever flips, the route has silently gone back to the path that
    // 503s on every large wallet.
    expect(rpc.calls).toBe(0)
  })

  it("⚠ subtracts the STALE portion — cached_fmv_usd is the TOTAL, the headline is not", async () => {
    // The 2026-09-02 migration that added the split states the contract:
    // headline = cached_fmv_usd - cached_fmv_stale_usd. Publishing the raw total
    // is the defect that migration exists to prevent (public profile read 80%
    // higher than the dashboard on this very wallet).
    cache.rows = [CACHED()]
    const body = await (await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))).json()
    expect(body.stats[0].fmv_total).toBeCloseTo(63007.85 - 4934.8, 2)
    expect(body.stats[0].fmv_stale_total).toBeCloseTo(4934.8, 2)
  })

  it("⚠ reports WHICH collections the answer covers, so a missing row cannot read as a zero", async () => {
    // Six wallets had no `ufc_strike` row at all on 2026-09-12 and three of them
    // held 247, 61 and 18 UFC Moments. A zero-filled tile there would be a claim
    // about a $1,547 holding.
    cache.rows = [CACHED(), CACHED({ collection_id: "c2", collections: { slug: "ufc_strike", name: "UFC Strike" } })]
    const body = await (await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))).json()
    expect(body.covered_collection_ids).toEqual(["c1", "c2"])
  })

  it("stamps the answer with the OLDEST cache time across the rows, not the newest", async () => {
    const old = new Date(Date.now() - 9 * 3_600_000).toISOString()
    const fresh = new Date(Date.now() - 60_000).toISOString()
    cache.rows = [CACHED({ cache_updated_at: fresh }), CACHED({ collection_id: "c2", cache_updated_at: old })]
    const body = await (await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))).json()
    // One "as of" is rendered for the whole card; the honest one is the age of
    // the least fresh number in it.
    expect(body.cache_updated_at).toBe(old)
  })

  it("keeps the freshest row when the same wallet is saved by more than one account", async () => {
    const older = new Date(Date.now() - 5 * 3_600_000).toISOString()
    const newer = new Date(Date.now() - 60_000).toISOString()
    cache.rows = [
      CACHED({ cache_updated_at: older, cached_moment_count: 1 }),
      CACHED({ cache_updated_at: newer, cached_moment_count: 99 }),
    ]
    const body = await (await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))).json()
    expect(body.stats).toHaveLength(1)
    expect(body.stats[0].moment_count).toBe(99)
  })

  // ── the live fallback ─────────────────────────────────────────────────────

  it("falls back to the live RPC when the wallet has no cached row yet", async () => {
    cache.rows = []
    rpc.data = [{ collection_id: "c1", moment_count: 3 }]
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe("live")
    expect(body.stats).toHaveLength(1)
  })

  it("⚠ a FAILED cache read degrades to the live RPC rather than failing the request", async () => {
    cache.error = { message: "cache boom" }
    rpc.data = [{ collection_id: "c1", moment_count: 3 }]
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe("live")
  })

  it("a THROWN cache read degrades the same way", async () => {
    cache.throws = true
    rpc.data = [{ collection_id: "c1", moment_count: 3 }]
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe("live")
  })

  it("maps a 57014 statement-timeout to 503 with retry", async () => {
    cache.rows = []
    rpc.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(503)
    expect((await res.json()).retry).toBe(true)
  })

  it("500s on any other RPC error", async () => {
    cache.rows = []
    rpc.error = { code: "12345", message: "boom" }
    const res = await GET(req("https://t/api/profile/collection-stats?wallet_addr=0xabc"))
    expect(res.status).toBe(500)
  })
})
