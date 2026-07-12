import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/set-squeeze. Thin wrapper over
// the topshot_set_squeeze_board view via a chained supabaseAdmin query builder.
// Pins the param guards (invalid set_tier / sort return 400 pre-DB) and the
// happy / rpc-error paths through a thenable mock builder.

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

import { GET } from "@/app/api/public/insights/set-squeeze/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any
const BASE = "https://t/api/public/insights/set-squeeze"

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/public/insights/set-squeeze", () => {
  it("400s on an invalid set_tier", async () => {
    const res = await GET(req(`${BASE}?set_tier=BOGUS`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("set_tier must be one of")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${BASE}?sort=nope`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns the board rows on the happy path", async () => {
    state.data = [{ set_id: "s1", set_name: "Base Set", avg_squeeze_pct: 72 }]
    const res = await GET(req(`${BASE}?series=8&set_tier=COMMON&sort=squeeze`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.source).toBe("topshot_set_squeeze_board")
    expect(body.meta.total_rows).toBe(1)
    expect(body.rows).toHaveLength(1)
  })

  it("500s on a query error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req(BASE))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
