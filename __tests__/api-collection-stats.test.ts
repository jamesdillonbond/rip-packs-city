import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-stats. No auth. Requires the
// `collection` param (400 if absent). Fans out to get_collection_stats plus a
// query_sql-backed HIGH/MEDIUM coverage computation (both via supabaseAdmin.rpc,
// mocked by name). Happy path enriches the stats with fmv_high_medium_* fields;
// a stats payload carrying an `error` key → 404.

const state: { stats: any; statsError: any; hm: any } = {
  stats: { editions: 100 },
  statsError: null,
  hm: [{ high_medium: 50, edition_total: 100 }],
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      if (name === "get_collection_stats") return { data: state.stats, error: state.statsError }
      if (name === "query_sql") return { data: state.hm, error: null }
      return { data: null, error: null }
    },
  },
}))

import { GET } from "@/app/api/collection-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.stats = { editions: 100 }
  state.statsError = null
  state.hm = [{ high_medium: 50, edition_total: 100 }]
})

describe("GET /api/collection-stats", () => {
  it("400s when the collection param is missing", async () => {
    const res = await GET(req("https://t/api/collection-stats"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection param required")
  })

  it("returns stats enriched with HIGH/MEDIUM FMV coverage", async () => {
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editions).toBe(100)
    expect(body.fmv_high_medium_count).toBe(50)
    expect(body.fmv_high_medium_pct).toBe(50)
  })

  it("404s when the stats RPC payload carries an error key (unknown collection)", async () => {
    state.stats = { error: "collection_not_found" }
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("collection_not_found")
  })

  it("returns 200 with stats_unavailable when the stats RPC errors", async () => {
    state.statsError = { message: "db down" }
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    // The route deliberately returns HTTP 200 with an error body, not a 5xx.
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe("stats_unavailable")
  })
})
