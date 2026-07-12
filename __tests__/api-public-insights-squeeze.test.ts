import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/squeeze. Thin wrapper over the
// topshot_squeeze_board view via a chained supabaseAdmin query builder. Pins the
// param guards (invalid tier / negative min_squeeze / invalid sort → 400 pre-DB)
// plus the happy and rpc-error paths through a thenable mock builder.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    gte: () => b,
    lte: () => b,
    ilike: () => b,
    order: () => b,
    limit: () => b,
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/public/insights/squeeze/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/squeeze"

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/public/insights/squeeze", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${BASE}?tier=BOGUS`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("400s on a negative min_squeeze", async () => {
    const res = await GET(req(`${BASE}?min_squeeze=-5`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("min_squeeze must be a non-negative")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${BASE}?sort=nope`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns board rows on the happy path", async () => {
    state.data = [{ edition_id: "e1", squeeze_pct: 81, player_name: "Wemby" }]
    const res = await GET(req(`${BASE}?tier=RARE&sort=squeeze&limit=10`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_squeeze_board")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s on a query error", async () => {
    state.error = { message: "boom" }
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("boom")
  })
})
