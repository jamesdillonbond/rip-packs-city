import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/trophies. Thin wrapper over the
// v_insights_trophies view via a chained supabaseAdmin query builder. Pins the
// param guards (invalid collection / type / sort → 400 pre-DB) plus the happy and
// rpc-error paths through a thenable mock builder.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => b,
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/public/insights/trophies/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/trophies"

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/public/insights/trophies", () => {
  it("400s on an invalid collection", async () => {
    const res = await GET(req(`${BASE}?collection=laliga_golazos`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection must be one of")
  })

  it("400s on an invalid type", async () => {
    const res = await GET(req(`${BASE}?type=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("type must be one of")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${BASE}?sort=nope`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns trophy rows on the happy path", async () => {
    state.data = [{ edition_id: "e1", is_one_of_one: true, fmv_usd: 9000 }]
    const res = await GET(req(`${BASE}?collection=nba_top_shot&type=one_of_one&sort=fmv`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("v_insights_trophies")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s on a query error", async () => {
    state.error = { message: "db" }
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("db")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
