import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

// POST /api/allday-pack-ev — the per-client bound on the UNCACHED path (R96,
// 2026-09-18). Pins:
//   - the 21st cache-miss from one client key inside a minute is refused with 429
//     and a Retry-After header, BEFORE any upstream fetch;
//   - a different client key is unaffected (isolation);
//   - a request with no platform client header is not limited (the helper's
//     contract — every other test in this suite builds header-less requests).
// The upstream is made to THROW so an uncached call returns 502; the limiter's
// verdict shows as 429 replacing that 502 — no node fixtures needed. (That cache
// HITS bypass the limiter is by construction — the check sits after the cache
// return — and is not asserted here; the cache-hit path lives in the branches file.)

const gql = vi.hoisted(() => ({ calls: 0 }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const b: any = {}
      for (const m of ["select", "in", "eq", "order", "upsert", "insert"]) b[m] = () => b
      b.then = (resolve: any) => resolve({ data: [], error: null })
      return b
    },
  }),
}))
vi.mock("@/lib/chains/flow/allday", () => ({
  alldayGraphql: async () => {
    gql.calls++
    throw new Error("upstream down")
  },
}))

const { POST } = await import("@/app/api/allday-pack-ev/route")

function post(packListingId: string, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("https://t/api/allday-pack-ev", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json", ...headers }),
      body: JSON.stringify({ packListingId, packPrice: 10 }),
    }),
  )
}

describe("allday-pack-ev — the uncached path is bounded per client key", () => {
  it("refuses the 21st cache-miss in a minute with 429 + Retry-After, before touching upstream", async () => {
    const ip = { "x-forwarded-for": "203.0.113.50, 10.0.0.1" }
    for (let i = 0; i < 20; i++) {
      const res = await post(`pack-a-${i}`, ip)
      expect(res.status).toBe(502) // upstream throws — the call REACHED upstream
    }
    const before = gql.calls
    const res = await post("pack-a-20", ip)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    const body = await res.json()
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(gql.calls).toBe(before) // refused BEFORE the fetch
  })

  it("another client key is unaffected by the first one's burst", async () => {
    const res = await post("pack-b-0", { "x-forwarded-for": "198.51.100.7" })
    expect(res.status).toBe(502)
  })

  it("x-real-ip is a client key too", async () => {
    const ip = { "x-real-ip": "192.0.2.9" }
    for (let i = 0; i < 20; i++) await post(`pack-c-${i}`, ip)
    expect((await post("pack-c-20", ip)).status).toBe(429)
  })

  it("a request with NO client header is not limited (never on Vercel; every header-less test request)", async () => {
    for (let i = 0; i < 25; i++) {
      expect((await post(`pack-d-${i}`)).status).toBe(502)
    }
  })
})
