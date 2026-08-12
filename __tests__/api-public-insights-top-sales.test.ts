import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/top-sales. The route validates
// collection against TOP_SALES_VALID_COLLECTIONS then delegates to fetchTopSales
// from lib/insights/top-sales. Keep the real parsers/whitelist (importOriginal),
// stub only fetchTopSales — pinning the 400 collection guard, the happy path, and
// the fetch-error → 500. (A sibling unit test insights-top-sales.test.ts already
// covers the parsers; this pins the wired route behavior.)

const fetchState: { rows: any[]; fetchedAt: string; err: any } = {
  rows: [],
  fetchedAt: "2026-07-12T00:00:00Z",
  err: null,
}

vi.mock("@/lib/insights/top-sales", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchTopSales: async () => {
      if (fetchState.err) throw fetchState.err
      return { rows: fetchState.rows, fetchedAt: fetchState.fetchedAt }
    },
  }
})

import { GET } from "@/app/api/public/insights/top-sales/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/top-sales"

beforeEach(() => {
  fetchState.rows = []
  fetchState.err = null
})

describe("GET /api/public/insights/top-sales", () => {
  it("400s on an invalid collection", async () => {
    const res = await GET(req(`${BASE}?collection=bogus_league`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("returns rows + meta on the happy path", async () => {
    fetchState.rows = [{ price_usd: 9000, buyer_handle: "@whale" }]
    const res = await GET(req(`${BASE}?collection=nba_top_shot&window=30d&sort=price`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("v_insights_top_sales")
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.fetched_at).toBe("2026-07-12T00:00:00Z")
    expect(body.rows).toHaveLength(1)
  })

  it("500s when the fetch throws", async () => {
    fetchState.err = new Error("view gone")
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("view gone")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
