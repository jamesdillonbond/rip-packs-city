import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep drive of GET /api/admin/flowty-analytics (the sibling test only pins the
// 401). This admin route fans out to the mv_flowty_* MVs + 5 leaderboard RPCs,
// then runs pure aggregation (bucket timeseries, period/lifetime summaries,
// leaderboard ranking). Backed by makeSupabaseFixture. Legs pinned: auth, the
// happy sales/loans/activations aggregation + ranked leaderboards, the collection
// filter branch, each resolveRange period→bucket branch (+ custom start/end), the
// invalid-param defaulting, and the query-error → empty-but-200 tolerance.

const A = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))

process.env.INGEST_SECRET_TOKEN = "ingest"
const { GET } = await import("@/app/api/admin/flowty-analytics/route")

type Fixtures = Parameters<typeof makeSupabaseFixture>[0]
function install(fixtures: Fixtures) { A.sb = makeSupabaseFixture(fixtures) }

function req(qs = "", auth = "Bearer ingest") {
  const u = new URL(`https://t/api/admin/flowty-analytics${qs}`)
  return { nextUrl: u, url: u.toString(), headers: new Headers(auth ? { authorization: auth } : {}) } as any
}

const salesRows = [
  { day: "2026-07-01", collection: "topshot", tx_count: 10, gross_volume_usd: 1000, distinct_buyers: 5, distinct_sellers: 4 },
  { day: "2026-07-02", collection: "topshot", tx_count: 6, gross_volume_usd: 600, distinct_buyers: 3, distinct_sellers: 2 },
]
const loanRows = [{ day: "2026-07-01", collection: "topshot", loan_count: 2, gross_volume_usd: 400 }]
const activationRows = [{ first_at: "2026-07-01T00:00:00Z", collection: "topshot", role: "buyer" }]
const board = (name: string) => [{ address: "0xa", volume_usd: 500 }, { address: "0xb", volume_usd: 300 }]

function fullFixture(): Fixtures {
  return {
    mv_flowty_sales_daily: { data: salesRows, error: null },
    mv_flowty_loans_daily: { data: loanRows, error: null },
    mv_flowty_first_activations: { data: activationRows, error: null },
    "rpc:flowty_top_buyers": { data: board("buyers"), error: null },
    "rpc:flowty_top_sellers": { data: board("sellers"), error: null },
    "rpc:flowty_top_net_marketplace": { data: board("net"), error: null },
    "rpc:flowty_top_lenders": { data: board("lenders"), error: null },
    "rpc:flowty_top_borrowers": { data: board("borrowers"), error: null },
  } as Fixtures
}

beforeEach(() => { install(fullFixture()) })

describe("GET /api/admin/flowty-analytics", () => {
  it("401 without a bearer token", async () => {
    expect((await GET(req("", ""))).status).toBe(401)
  })

  it("happy path: aggregates sales, ranks leaderboards, returns the full envelope", async () => {
    const body = await (await GET(req("?collection=topshot&period=monthly"))).json()
    expect(body.meta.collection).toBe("topshot")
    expect(body.meta.period).toBe("monthly")
    expect(body.meta.bucket).toBe("month")
    // period sales volume = sum of gross_volume_usd
    expect(body.summary.salesPeriodVolumeUsd).toBe(1600)
    expect(body.summary.salesPeriodTxCount).toBe(16)
    expect(Array.isArray(body.salesTimeseries)).toBe(true)
    expect(body.salesTimeseries.length).toBeGreaterThan(0)
    // leaderboards are ranked 1..N
    expect(body.leaderboards.topBuyers[0].rank).toBe(1)
    expect(body.leaderboards.topBuyers[1].rank).toBe(2)
    expect(body.leaderboards.topSellers[0].rank).toBe(1)
  })

  it("collection=all does not apply the collection filter (still 200)", async () => {
    const body = await (await GET(req("?collection=all"))).json()
    expect(body.meta.collection).toBe("all")
    expect(body.summary.salesPeriodTxCount).toBe(16)
  })

  it.each([
    ["daily", "day"],
    ["weekly", "week"],
    ["monthly", "month"],
    ["annual", "year"],
    ["all", "month"],
  ])("period=%s resolves bucket=%s", async (period, bucket) => {
    const body = await (await GET(req(`?period=${period}`))).json()
    expect(body.meta.period).toBe(period)
    expect(body.meta.bucket).toBe(bucket)
  })

  it("a custom start/end range is honored", async () => {
    const body = await (await GET(req("?period=monthly&start=2026-06-01T00:00:00Z&end=2026-06-30T00:00:00Z"))).json()
    expect(body.meta.start).toBe("2026-06-01T00:00:00.000Z")
    expect(body.meta.end).toBe("2026-06-30T00:00:00.000Z")
  })

  it("invalid collection/period fall back to all/monthly", async () => {
    const body = await (await GET(req("?collection=bogus&period=bogus"))).json()
    expect(body.meta.collection).toBe("all")
    expect(body.meta.period).toBe("monthly")
  })

  it("a sales-query error degrades to empty aggregation but still 200", async () => {
    install({
      ...fullFixture(),
      mv_flowty_sales_daily: { data: null, error: { message: "mv down" } },
    } as Fixtures)
    const res = await GET(req("?collection=topshot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.salesPeriodVolumeUsd).toBe(0)
    expect(body.salesTimeseries).toEqual([])
  })

  it("a leaderboard rpc error yields an empty board (not a crash)", async () => {
    install({
      ...fullFixture(),
      "rpc:flowty_top_buyers": { data: null, error: { message: "board down" } },
    } as Fixtures)
    const body = await (await GET(req("?collection=topshot"))).json()
    expect(body.leaderboards.topBuyers).toEqual([])
    expect(body.leaderboards.topSellers[0].rank).toBe(1) // others unaffected
  })
})
