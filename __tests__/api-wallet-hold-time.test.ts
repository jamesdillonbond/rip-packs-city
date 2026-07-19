import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Drives GET /api/wallet-hold-time end-to-end. Pins the param guards, the
// non-TopShot short-circuit, username→wallet resolution, and — the real logic —
// the hold-time bucketing of moment_acquisitions rows (deterministic via fake
// timers). moment_acquisitions is TopShot-only, so other collections return a
// 200 empty payload the card hides on, not a 404.

type Result = { data: any; error: any }
const state: { rows: Array<{ acquired_date: string }>; error: any; username: any } = {
  rows: [],
  error: null,
  username: null,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        not: () => b,
        range: (start: number): Promise<Result> =>
          Promise.resolve(state.error ? { data: null, error: state.error } : { data: state.rows.slice(start, start + 1000), error: null }),
      }
      return b
    },
  },
}))

// resolveWallet uses this only for non-0x (username) input.
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => state.username,
}))

import { GET } from "@/app/api/wallet-hold-time/route"

const req = (qs: string) => ({ nextUrl: new URL("https://t/api/wallet-hold-time" + qs) }) as any
const WALLET = "0x1234567890abcdef" // 18 chars → resolveWallet returns it directly
const NOW = new Date("2026-07-19T00:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString()

beforeEach(() => {
  state.rows = []
  state.error = null
  state.username = null
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe("GET /api/wallet-hold-time — guards", () => {
  it("400s without a wallet", async () => {
    const res = await GET(req("?collection=nba-top-shot"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an unknown collection slug", async () => {
    const res = await GET(req(`?wallet=${WALLET}&collection=not_a_collection`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("non-TopShot collection returns an empty payload with the graceful reason (200)", async () => {
    const res = await GET(req(`?wallet=${WALLET}&collection=nfl-all-day`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([])
    expect(body.reason).toBe("acquisition_data_unavailable")
  })

  it("500s when the acquisitions query errors", async () => {
    state.error = { message: "db down" }
    const res = await GET(req(`?wallet=${WALLET}&collection=nba-top-shot`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})

describe("GET /api/wallet-hold-time — bucketing", () => {
  it("buckets acquisitions by hold time and reports the canonical bucket order", async () => {
    state.rows = [
      { acquired_date: daysAgo(10) }, // 0-30d
      { acquired_date: daysAgo(60) }, // 30-90d
      { acquired_date: daysAgo(120) }, // 90-180d
      { acquired_date: daysAgo(300) }, // 180-365d
      { acquired_date: daysAgo(400) }, // 365d+
      { acquired_date: "not-a-date" }, // unparseable → skipped in counts, still in total
    ]
    const body = await (await GET(req(`?wallet=${WALLET}&collection=nba-top-shot`))).json()
    expect(body.total).toBe(6) // total is row count, including the unparseable row
    expect(body.buckets).toEqual([
      { bucket: "0-30d", count: 1 },
      { bucket: "30-90d", count: 1 },
      { bucket: "90-180d", count: 1 },
      { bucket: "180-365d", count: 1 },
      { bucket: "365d+", count: 1 },
    ])
  })

  it("bucket edges are lower-inclusive (30d → 30-90d, 365d → 365d+)", async () => {
    state.rows = [{ acquired_date: daysAgo(30) }, { acquired_date: daysAgo(365) }]
    const body = await (await GET(req(`?wallet=${WALLET}&collection=nba-top-shot`))).json()
    const byBucket = Object.fromEntries(body.buckets.map((b: any) => [b.bucket, b.count]))
    expect(byBucket["30-90d"]).toBe(1) // 30 is NOT < 30
    expect(byBucket["365d+"]).toBe(1) // 365 is NOT < 365
    expect(byBucket["0-30d"]).toBe(0)
  })

  it("a future acquired_date clamps to 0 days (0-30d, never negative)", async () => {
    state.rows = [{ acquired_date: daysAgo(-5) }] // 5 days in the future
    const body = await (await GET(req(`?wallet=${WALLET}&collection=nba-top-shot`))).json()
    expect(body.buckets.find((b: any) => b.bucket === "0-30d").count).toBe(1)
  })

  it("resolves a username to its flowAddress before bucketing", async () => {
    state.username = { getUserProfileByUsername: { publicInfo: { flowAddress: "0xabc0000000000001" } } }
    state.rows = [{ acquired_date: daysAgo(5) }]
    const body = await (await GET(req(`?wallet=someuser&collection=nba-top-shot`))).json()
    expect(body.wallet).toBe("0xabc0000000000001")
    expect(body.total).toBe(1)
  })

  it("500s when a username cannot be resolved", async () => {
    state.username = { getUserProfileByUsername: { publicInfo: { flowAddress: null } } }
    const res = await GET(req(`?wallet=ghostuser&collection=nba-top-shot`))
    expect(res.status).toBe(500)
  })
})
