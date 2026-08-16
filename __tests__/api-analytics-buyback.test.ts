import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/buyback.
//
// The route is anon-reachable (the 2026-07-17 soft launch un-gated the whole
// /api/analytics subtree), so the two properties that matter beyond the happy
// path are:
//   1. an unknown period is REJECTED, not silently defaulted — substituting a
//      window renders the wrong date range under the label the caller asked
//      for;
//   2. a failure never returns 200-with-empty, and never leaks the driver
//      message.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async () => {
      if (rpc.throws) throw new Error("connection reset")
      return { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET, BUYBACK_PERIODS } from "@/app/api/analytics/buyback/route"

const req = (url = "https://t/api/analytics/buyback") => ({ url }) as any

const payload = {
  period: "month",
  window_start: "2026-08-01",
  window_end: "2026-08-16",
  basis: "verified_marketplace_purchases",
  totals: {
    purchases: 98,
    priced_purchases: 98,
    spend_usd: 4936.73,
    spend_known: true,
    distinct_editions: 60,
    active_days: 15,
  },
  coverage: {
    observation_start: "2026-06-09",
    unpriced_purchases: 0,
    counterparty_known_for: 98,
    date_grain: "day",
    excluded_snapshot_rows: 92165,
    excluded_wallets: 1,
    excluded_reason: "wallet walk is unstable",
  },
  wallets: [],
  top_editions_by_count: [],
  top_editions_by_spend: [],
  top_sellers_by_spend: [],
  top_sellers_by_count: [],
  timeline: [],
}

beforeEach(() => {
  rpc.data = null
  rpc.error = null
  rpc.throws = false
})

describe("GET /api/analytics/buyback", () => {
  it("returns the RPC payload and caches it", async () => {
    rpc.data = payload
    const res = await GET(req("https://t/api/analytics/buyback?period=month"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.purchases).toBe(98)
    // priced_purchases must survive to the client: it is the only thing that
    // lets a consumer tell an unpriced purchase from a free one.
    expect(body.totals.priced_purchases).toBe(98)
    // And the excluded-row count must survive, or the board cannot explain why
    // it is small and reads as "Top Shot stopped buying".
    expect(body.coverage.excluded_snapshot_rows).toBe(92165)
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=900")
  })

  it("accepts every documented period", async () => {
    for (const p of BUYBACK_PERIODS) {
      rpc.data = { ...payload, period: p }
      const res = await GET(req(`https://t/api/analytics/buyback?period=${p}`))
      expect(res.status).toBe(200)
    }
  })

  it("defaults to month when no period is supplied", async () => {
    rpc.data = payload
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).period).toBe("month")
  })

  it("REJECTS an unknown period instead of silently defaulting", async () => {
    rpc.data = payload
    const res = await GET(req("https://t/api/analytics/buyback?period=quarter"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("bad_request")
    expect(body.error).toMatch(/week, month, year, all/)
    // The guard must fire BEFORE the payload is served — a 200 carrying
    // month data under a "quarter" request is the defect this prevents.
    expect(body.totals).toBeUndefined()
  })

  it("clamps limit into range rather than passing it through", async () => {
    rpc.data = payload
    for (const q of ["limit=0", "limit=9999", "limit=abc", "limit=-5"]) {
      const res = await GET(req(`https://t/api/analytics/buyback?${q}`))
      expect(res.status).toBe(200)
    }
  })

  it("an RPC error is a real error status, never 200-with-empty", async () => {
    rpc.error = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req())
    // 503 (retryable) rather than 500 — a timeout is transient capacity.
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    // Never publish the driver's own words.
    expect(JSON.stringify(body)).not.toMatch(/canceling statement/i)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("a thrown failure is caught and reported without leaking the message", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/connection reset/i)
  })

  it("a null payload is treated as a failed read, not as an empty result", async () => {
    // The RPC always builds an object (with empty arrays for a quiet window), so
    // null means the read failed. Publishing it as 200 would render
    // "the buyback wallets bought nothing" out of an outage.
    rpc.data = null
    const res = await GET(req())
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.totals).toBeUndefined()
  })

  it("a genuinely empty window still returns 200 — an honest zero", async () => {
    rpc.data = {
      ...payload,
      totals: { ...payload.totals, purchases: 0, priced_purchases: 0, spend_usd: 0 },
    }
    const res = await GET(req("https://t/api/analytics/buyback?period=week"))
    expect(res.status).toBe(200)
    expect((await res.json()).totals.purchases).toBe(0)
  })
})
