import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market-sparklines (GET). No auth. Mocks
// @supabase/supabase-js createClient (thenable builder on fmv_snapshots).
// Pins the empty-editionIds guard and the group-by-edition sparkline build.

// ⚠ The mock yields `{ data, error }`, not `{ data }` alone. A mock that cannot
// express `{ data: null, error }` cannot express the failure the honesty cases
// below exist to pin — the old `const { data } = …` route would have passed
// against a data-only mock forever.
const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    in: () => b,
    gte: () => b,
    order: async () => ({ data: state.data, error: state.error }),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/market-sparklines/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/market-sparklines", () => {
  it("returns an empty map when no editionIds provided", async () => {
    const res = await GET(req("https://t/api/market-sparklines"))
    expect(res.status).toBe(200)
    expect((await res.json()).sparklines).toEqual({})
  })

  it("returns an empty map when editionIds is only commas", async () => {
    const res = await GET(req("https://t/api/market-sparklines?editionIds=,,"))
    expect((await res.json()).sparklines).toEqual({})
  })

  // HONESTY CANON. The read used to swallow `error`, so a failed read answered
  // `{ sparklines: {} }` at HTTP 200 under `s-maxage=300` — a flat/absent 7-day
  // line for every requested edition, i.e. "these did not move", cached at the
  // CDN for five minutes. Pinned as the ABSENCE of that answer.
  it("does not publish an empty sparkline map when the read errored", async () => {
    state.data = null
    state.error = { message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/market-sparklines?editionIds=u1,u2"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body.sparklines).toBeUndefined()
    // apiErrorResponse classifies server-side; the driver text stays there.
    expect(JSON.stringify(body)).not.toContain("canceling statement")
    // A failure must not be cacheable — apiErrorResponse sets no-store.
    expect(res.headers.get("Cache-Control")).toContain("no-store")
  })

  it("a genuinely empty 7-day window still answers 200 with {} — positive control", async () => {
    state.data = []
    state.error = null
    const res = await GET(req("https://t/api/market-sparklines?editionIds=u1,u2"))
    expect(res.status).toBe(200)
    expect((await res.json()).sparklines).toEqual({})
  })

  it("groups fmv points into per-edition sparkline arrays", async () => {
    state.data = [
      { edition_id: "u1", fmv_usd: 10, computed_at: "2026-07-01T00:00:00Z" },
      { edition_id: "u1", fmv_usd: 12, computed_at: "2026-07-02T00:00:00Z" },
      { edition_id: "u2", fmv_usd: 5, computed_at: "2026-07-01T00:00:00Z" },
    ]
    const res = await GET(req("https://t/api/market-sparklines?editionIds=u1,u2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sparklines.u1).toEqual([10, 12])
    expect(body.sparklines.u2).toEqual([5])
  })
})
