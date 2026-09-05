import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep test for GET /api/market-analytics — drives the aggregation math and the
// detail=full / comparison / Pinnacle-dispatch shaping that the shallow test
// (400 guard + empty totals + daily-RPC 500) leaves uncovered. Assertions target
// handler-COMPUTED output: summed totals, per-day rounding, the assembled detail
// arrays, the Pinnacle stable-empty shape, and the player-search gating.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

import { GET } from "@/app/api/market-analytics/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  state.sb = null
})

describe("GET /api/market-analytics — base aggregation", () => {
  it("sums totals across daily rows and rounds per-day volume to 2dp", async () => {
    install({
      "rpc:get_daily_marketplace_volume": {
        data: [
          { day: "2026-07-15", marketplace: "topshot", sale_count: 3, volume_usd: 12.345 },
          { day: "2026-07-16", marketplace: "dapper", sale_count: 2, volume_usd: 7.111 },
        ],
        error: null,
      },
    })

    const res = await GET(req("https://t/api/market-analytics?collection=nba-top-shot&period=30d"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.totalSales).toBe(5)
    expect(body.totals.totalVolume).toBe(19.46) // 12.345 + 7.111 = 19.456 → 19.46
    expect(body.daily).toEqual([
      { date: "2026-07-15", marketplace: "topshot", saleCount: 3, volume: 12.35 },
      { date: "2026-07-16", marketplace: "dapper", saleCount: 2, volume: 7.11 },
    ])
    expect(body.period).toBe("30d")
  })
})

describe("GET /api/market-analytics — detail=full", () => {
  it("assembles all breakdown arrays and includes playerSearch only when a player is supplied", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_top_sales": { data: [{ id: "s1" }], error: null },
      "rpc:get_tier_analytics": { data: [{ tier: "RARE" }], error: null },
      "rpc:get_top_editions": { data: [{ ed: "e1" }], error: null },
      "rpc:get_daily_tier_volume": { data: [{ day: "d" }], error: null },
      "rpc:get_badge_premium": { data: [{ badge: "b" }], error: null },
      "rpc:get_series_analytics": { data: [{ series: 1 }], error: null },
      "rpc:get_daily_series_volume": { data: [{ day: "d2" }], error: null },
      "rpc:search_player_analytics": { data: [{ player: "Dame" }], error: null },
    })

    const body = await (
      await GET(req("https://t/api/market-analytics?collection=nba-top-shot&detail=full&player=Dame"))
    ).json()
    expect(body.topSales).toEqual([{ id: "s1" }])
    expect(body.tierAnalytics).toEqual([{ tier: "RARE" }])
    expect(body.topEditions).toEqual([{ ed: "e1" }])
    expect(body.dailyTierVolume).toEqual([{ day: "d" }])
    expect(body.badgePremium).toEqual([{ badge: "b" }])
    expect(body.seriesAnalytics).toEqual([{ series: 1 }])
    expect(body.dailySeriesVolume).toEqual([{ day: "d2" }])
    expect(body.playerSearch).toEqual([{ player: "Dame" }])
  })

  it("omits playerSearch entirely when no player param is given", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_top_sales": { data: [], error: null },
      "rpc:get_tier_analytics": { data: [], error: null },
      "rpc:get_top_editions": { data: [], error: null },
      "rpc:get_daily_tier_volume": { data: [], error: null },
      "rpc:get_badge_premium": { data: [], error: null },
      "rpc:get_series_analytics": { data: [], error: null },
      "rpc:get_daily_series_volume": { data: [], error: null },
    })

    const body = await (
      await GET(req("https://t/api/market-analytics?collection=nba-top-shot&detail=full"))
    ).json()
    expect("playerSearch" in body).toBe(false)
  })
})

describe("GET /api/market-analytics — Pinnacle dispatch", () => {
  it("routes to pinnacle_* RPCs and returns stable-empty badge/series arrays", async () => {
    install({
      "rpc:get_daily_marketplace_volume_pinnacle": {
        data: [{ day: "2026-07-16", marketplace: "pinnacle", sale_count: 4, volume_usd: 10 }],
        error: null,
      },
      "rpc:pinnacle_top_sales": { data: [{ id: "p1" }], error: null },
      "rpc:pinnacle_tier_analytics": { data: [{ tier: "CHASER" }], error: null },
      "rpc:pinnacle_top_editions": { data: [{ ed: "pe1" }], error: null },
      "rpc:pinnacle_daily_tier_volume": { data: [{ day: "pd" }], error: null },
    })

    const body = await (
      await GET(req("https://t/api/market-analytics?collection=disney-pinnacle&detail=full"))
    ).json()
    expect(body.totals.totalSales).toBe(4)
    expect(body.topSales).toEqual([{ id: "p1" }])
    expect(body.tierAnalytics).toEqual([{ tier: "CHASER" }])
    // Pinnacle has no badges / NBA-style series — shape stays stable.
    expect(body.badgePremium).toEqual([])
    expect(body.seriesAnalytics).toEqual([])
    expect(body.dailySeriesVolume).toEqual([])
  })
})

describe("GET /api/market-analytics — comparison", () => {
  it("surfaces the period comparison payload when comparison=true", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_period_comparison": {
        data: { current: 100, prior: 80, pct_change: 25 },
        error: null,
      },
    })

    const body = await (
      await GET(req("https://t/api/market-analytics?collection=nba-top-shot&comparison=true&period=7d"))
    ).json()
    expect(body.periodComparison).toEqual({ current: 100, prior: 80, pct_change: 25 })
  })

  it("nulls periodComparison when the comparison RPC errors (degrades honestly)", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_period_comparison": { data: null, error: { message: "cmp fail" } },
    })

    const body = await (
      await GET(req("https://t/api/market-analytics?collection=nba-top-shot&comparison=true"))
    ).json()
    expect(body.periodComparison).toBeNull()
  })

  it("routes the Pinnacle collection to pinnacle_period_comparison", async () => {
    install({
      "rpc:get_daily_marketplace_volume_pinnacle": { data: [], error: null },
      "rpc:pinnacle_period_comparison": { data: { current: 5, prior: 4 }, error: null },
    })
    const body = await (
      await GET(req("https://t/api/market-analytics?collection=disney-pinnacle&comparison=true&period=90d"))
    ).json()
    expect(body.periodComparison).toEqual({ current: 5, prior: 4 })
  })
})

describe("GET /api/market-analytics — period windows", () => {
  it("accepts the 'all' period end-to-end (getStartDate + periodToDays 'all' branches)", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_period_comparison": { data: { pct: 0 }, error: null },
    })
    const res = await GET(
      req("https://t/api/market-analytics?collection=nba-top-shot&period=all&comparison=true"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.period).toBe("all")
    expect(body.startDate).toBe("2021-01-01")
    expect(body.periodComparison).toEqual({ pct: 0 })
  })

  it("accepts the 'ytd' period end-to-end (computed start + periodToDays 'ytd' branch)", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_period_comparison": { data: null, error: null },
    })
    const res = await GET(
      req("https://t/api/market-analytics?collection=nba-top-shot&period=ytd&comparison=true"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.period).toBe("ytd")
    // ytd start is Jan 1 of the current year
    expect(body.startDate).toMatch(/^\d{4}-01-01$/)
  })

  it("falls through to the 30-day default for an unrecognized period (getStartDate + periodToDays defaults)", async () => {
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_period_comparison": { data: null, error: null },
    })
    const res = await GET(
      req("https://t/api/market-analytics?collection=nba-top-shot&period=weird&comparison=true"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // period echoes the raw param but the start-date math takes the default branch.
    expect(body.period).toBe("weird")
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("GET /api/market-analytics — detail=full degrade paths", () => {
  it("still returns 200 with empty arrays when every breakdown RPC errors (non-Pinnacle)", async () => {
    const errEach = { data: null, error: { message: "leg failed" } }
    install({
      "rpc:get_daily_marketplace_volume": { data: [], error: null },
      "rpc:get_top_sales": errEach,
      "rpc:get_tier_analytics": errEach,
      "rpc:get_top_editions": errEach,
      "rpc:get_daily_tier_volume": errEach,
      "rpc:get_badge_premium": errEach,
      "rpc:get_series_analytics": errEach,
      "rpc:get_daily_series_volume": errEach,
      "rpc:search_player_analytics": errEach,
    })
    const res = await GET(
      req("https://t/api/market-analytics?collection=nba-top-shot&detail=full&player=Dame"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // errored legs fall through to the `?? []` empties, response stays stable.
    expect(body.topSales).toEqual([])
    expect(body.tierAnalytics).toEqual([])
    expect(body.badgePremium).toEqual([])
    expect(body.playerSearch).toEqual([])
  })

  it("still returns 200 with empty arrays when every Pinnacle breakdown RPC errors, and honors playerSearch gating", async () => {
    const errEach = { data: null, error: { message: "pinnacle leg failed" } }
    install({
      "rpc:get_daily_marketplace_volume_pinnacle": { data: [], error: null },
      "rpc:pinnacle_top_sales": errEach,
      "rpc:pinnacle_tier_analytics": errEach,
      "rpc:pinnacle_top_editions": errEach,
      "rpc:pinnacle_daily_tier_volume": errEach,
    })
    const res = await GET(
      req("https://t/api/market-analytics?collection=disney-pinnacle&detail=full&player=Mickey"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.topSales).toEqual([])
    expect(body.tierAnalytics).toEqual([])
    // Pinnacle's player branch returns a stable empty array when a player is given.
    expect(body.playerSearch).toEqual([])
  })
})

describe("GET /api/market-analytics — fatal catch", () => {
  it("500s with a generic message when the daily RPC throws", async () => {
    // Replace the whole client with one whose rpc rejects, so the outer try/catch fires.
    state.sb = { rpc: async () => { throw new Error("connection reset") } }
    const res = await GET(req("https://t/api/market-analytics?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Internal server error")
  })
})

// ── A PANEL WE COULD NOT READ IS NOT AN EMPTY PANEL ────────────────────────
//
// 2026-09-04. Every detail panel was published as `res.data ?? []` with its
// error sent to `console.log` and nowhere else. supabase-js RETURNS errors
// rather than throwing, so a failed leg resolves `{ data: null, error }`, `?? []`
// makes it an empty array, and the response is a confident 200 asserting "no top
// sales in this period" about a query that never ran — twelve times in one route,
// on the collection analytics page.
//
// ⚠ The arrays deliberately STAY `[]` so the response shape is unchanged for
// every existing consumer. `degraded` ADDS the distinction; it does not move one.
describe("GET /api/market-analytics — degraded panels are named, not silently emptied", () => {
  const base = {
    "rpc:get_daily_marketplace_volume": {
      data: [{ day: "2026-07-15", marketplace: "topshot", sale_count: 1, volume_usd: 1 }],
      error: null,
    },
  }
  const url = "https://t/api/market-analytics?collection=nba-top-shot&period=30d&detail=full"

  it("names a failed panel in `degraded` while keeping its array empty", async () => {
    install({ ...base, "rpc:get_top_sales": { data: null, error: { message: "boom" } } })
    const body = await (await GET(req(url))).json()
    expect(body.degraded).toContain("topSales")
    // Shape unchanged — an existing consumer still gets an array.
    expect(body.topSales).toEqual([])
  })

  it("reports an EMPTY degraded list when every panel read succeeded", async () => {
    // The control that gives `degraded` meaning. Always present, so
    // `degraded.length === 0` is a positive statement that every panel we
    // attempted was read — not merely the absence of a key.
    install(base)
    const body = await (await GET(req(url))).json()
    expect(body.degraded).toEqual([])
    expect(Array.isArray(body.topSales)).toBe(true)
  })

  it("does NOT mark Pinnacle's structurally-absent panels as degraded", async () => {
    // ⛔ The defect pointed the other way. Pinnacle has no badge or NBA-style
    // series analytics at all, so those arrays are a MEASURED empty. Listing them
    // would replace a true "there is none" with "we could not load this".
    install({
      "rpc:get_daily_marketplace_volume_pinnacle": {
        data: [{ day: "2026-07-15", marketplace: "pinnacle", sale_count: 1, volume_usd: 1 }],
        error: null,
      },
    })
    const body = await (
      await GET(req("https://t/api/market-analytics?collection=disney-pinnacle&period=30d&detail=full"))
    ).json()
    expect(body.badgePremium).toEqual([])
    expect(body.seriesAnalytics).toEqual([])
    expect(body.dailySeriesVolume).toEqual([])
    expect(body.degraded).not.toContain("badgePremium")
    expect(body.degraded).not.toContain("seriesAnalytics")
    expect(body.degraded).not.toContain("dailySeriesVolume")
  })

  it("lists a failed period comparison too, so one field answers what we could not read", async () => {
    install({ ...base, "rpc:get_period_comparison": { data: null, error: { message: "boom" } } })
    const body = await (
      await GET(req("https://t/api/market-analytics?collection=nba-top-shot&period=30d&comparison=true"))
    ).json()
    // null was already honest on its own — a null is not a number. It joins
    // `degraded` so a caller need not know this panel signals failure differently.
    expect(body.periodComparison).toBeNull()
    expect(body.degraded).toContain("periodComparison")
  })

  it("does not mark an UNSEARCHED player panel as degraded", async () => {
    // Absent is not failed: with no `player` param the RPC is never issued.
    install(base)
    const body = await (await GET(req(url))).json()
    expect(body.degraded).not.toContain("playerSearch")
    expect(body.playerSearch).toBeUndefined()
  })
})
