import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// A DATABASE READ THAT HANGS MUST RESOLVE INTO THE ROUTE'S OWN DEGRADED BRANCH,
// NOT HOLD THE RESPONSE UNTIL VERCEL KILLS IT.
//
// ⭐ THE CASE (inbox 2026-09-03T0850Z). `/api/sniper-feed` bounded NOTHING on the
// database side: `get_topshot_sniper_deals` ran at a 6,898 ms MEAN over 6,746
// calls with its maximum pinned at the 30 s `statement_timeout`, and the route
// produced 3 × `Task timed out after 45 seconds` in a day against 455 × 200.
// Every deal-bearing read already had an honest `if (error)` branch that notes
// the source and renders "COULDN'T LOAD THE FLOOR" — a slow read just never
// reached it. The bound (`boundedRead`) makes an overrun RESOLVE with a
// synthetic error so that branch does the work.
//
// ⚠ Each hanging case drives a read that NEVER settles (a `then` that never
// calls back). Without the bound these tests would hang until vitest's own
// timeout — which is the point: the assertion is that the route answers at all,
// and answers honestly. The budget is set to 50 ms through the env override
// that exists for exactly this file, so a hang is proven in milliseconds.
//
// ⚠ Controls, both directions: a read that resolves INSIDE the 50 ms budget must
// not be reported as failed (the bound cannot be a false alarm), and a healthy
// build under the default budget must be byte-for-byte the no-change shape.
// ─────────────────────────────────────────────────────────────────────────────

const cacheState = vi.hoisted(() => ({ deleted: [] as string[] }))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _t: number, fn: any) => fn(),
  deleteCache: (key: string) => { cacheState.deleted.push(key) },
}))

const st = vi.hoisted(() => ({
  // Tables whose read never settles.
  hangOn: new Set<string>(),
  // Tables whose read settles late but inside the budget (ms).
  slowOn: new Map<string, number>(),
  editions: { data: [] as any[], error: null as any },
}))
const rpc = vi.hoisted(() =>
  vi.fn<(name: string, params?: unknown) => Promise<any>>(async () => ({ data: [], error: null })),
)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b, gt: () => b, limit: () => b, range: () => b,
        then: (resolve: any) => {
          if (st.hangOn.has(table)) return // never settles
          const payload = table === "editions" ? st.editions : { data: [], error: null }
          const delay = st.slowOn.get(table)
          if (delay) { setTimeout(() => resolve(payload), delay); return }
          resolve(payload)
        },
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

const never = () => new Promise<any>(() => {})
const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const ADQS = "?collection=nfl-all-day&minDiscount=0&maxPrice=100000&rarity=all&team=all"
const TSQS = "?collection=nba-top-shot&minDiscount=0&maxPrice=100000&rarity=all&team=all"

beforeEach(() => {
  cacheState.deleted = []
  st.hangOn = new Set()
  st.slowOn = new Map()
  st.editions = { data: [], error: null }
  rpc.mockReset()
  rpc.mockImplementation(async () => ({ data: [], error: null }))
  vi.stubEnv("SNIPER_DB_READ_TIMEOUT_MS", "50")
  // Both marketplace GQL pools answer empty, so the Top Shot path is "sparse"
  // and augments from `get_topshot_sniper_deals`, and the All Day path falls
  // back to `get_allday_sniper_deals` — the two reads this file is about.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ data: { searchMarketplaceEditions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } }),
  })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("GET /api/sniper-feed — a hanging database read resolves into the degraded branch", () => {
  it("a ts_listings read that never settles is NAMED and the board is degraded, within the budget", async () => {
    st.hangOn = new Set(["ts_listings"])
    const t0 = Date.now()
    const res = await GET(get(TSQS))
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sourcesFailed).toContain("ts_listings")
    expect(body.degraded).toBe(true)
    // The degraded build must not be cached as a warm answer.
    expect(cacheState.deleted.length).toBeGreaterThan(0)
  })

  it("a get_topshot_sniper_deals RPC that never settles is NAMED — the 6.9 s-mean read that motivated this", async () => {
    rpc.mockImplementation((name: string) => (name === "get_topshot_sniper_deals" ? never() : Promise.resolve({ data: [], error: null })))
    const t0 = Date.now()
    const body = await (await GET(get(TSQS))).json()
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(body.sourcesFailed).toContain("topshot-deals-rpc")
    expect(body.degraded).toBe(true)
  })

  it("a get_allday_sniper_deals RPC that never settles is NAMED and lastRefreshed stays null", async () => {
    rpc.mockImplementation((name: string) => (name === "get_allday_sniper_deals" ? never() : Promise.resolve({ data: [], error: null })))
    const t0 = Date.now()
    const body = await (await GET(get(ADQS))).json()
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(body.sourcesFailed).toContain("allday-deals-rpc")
    expect(body.degraded).toBe(true)
    // A failed read must not carry a freshness claim (the route's own rule).
    expect(body.lastRefreshed).toBeNull()
  })

  it("an All Day EDITIONS read that never settles is NAMED under the FMV source it gates", async () => {
    st.hangOn = new Set(["editions"])
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-fmv")
    expect(body.degraded).toBe(true)
  })

  it("a get_editions_latest_fmv chunk that never settles is NAMED", async () => {
    st.editions = { data: [{ id: "e1", external_id: "555" }], error: null }
    rpc.mockImplementation((name: string) => (name === "get_editions_latest_fmv" ? never() : Promise.resolve({ data: [], error: null })))
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-fmv")
    expect(body.degraded).toBe(true)
  })

  // ── Controls ──────────────────────────────────────────────────────────────

  it("CONTROL — a read that settles INSIDE the budget is not reported as failed", async () => {
    // 20 ms against a 50 ms budget. If the bound fired early, or fired on a
    // read that merely took time, this would be a false alarm on every slow
    // instance — the same wolf-crying this repo records for the liveness arm.
    st.slowOn = new Map([["ts_listings", 20]])
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).not.toContain("ts_listings")
  })

  it("CONTROL — under the default budget a healthy build is the no-change shape", async () => {
    vi.unstubAllEnvs()
    const body = await (await GET(get(ADQS))).json()
    expect(body.degraded).toBe(false)
    expect(body.sourcesFailed).toEqual([])
    expect(cacheState.deleted).toEqual([])
  })

  it("the env override is the ONLY thing that shortens the budget — a non-numeric value falls back to the default", async () => {
    // Pinned because the override exists for this file alone; a production
    // misconfiguration must not become a 0 ms budget that fails every read.
    vi.stubEnv("SNIPER_DB_READ_TIMEOUT_MS", "soon")
    st.slowOn = new Map([["ts_listings", 120]]) // would exceed a 50 ms budget, trivially inside 8 s
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).not.toContain("ts_listings")
  })
})
