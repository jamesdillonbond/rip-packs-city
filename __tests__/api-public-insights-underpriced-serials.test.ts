import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/underpriced-serials. The route
// does its own tier guard then delegates to fetchUnderpricedSerials from
// lib/underpriced-serials-board. Keep the real parsers (importOriginal) and stub
// only the fetch fn — pinning the 400 tier guard, the happy path, and the
// fetch-error → 500.

const fetchState: { rows: any[]; err: any } = { rows: [], err: null }

vi.mock("@/lib/underpriced-serials-board", async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    fetchUnderpricedSerials: async () => {
      if (fetchState.err) throw fetchState.err
      return fetchState.rows
    },
  }
})

import { GET } from "@/app/api/public/insights/underpriced-serials/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/underpriced-serials"

beforeEach(() => {
  fetchState.rows = []
  fetchState.err = null
})

describe("GET /api/public/insights/underpriced-serials", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${BASE}?tier=BOGUS`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("returns rows + meta on the happy path", async () => {
    fetchState.rows = [{ headline_serial: 1, discount_pct: 42, estimate_quality: "tight" }]
    const res = await GET(req(`${BASE}?headline=no1&quality=tight&sort=discount`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_underpriced_serials_board")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s when the fetch throws", async () => {
    fetchState.err = new Error("board down")
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("board down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
