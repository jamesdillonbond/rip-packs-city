import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-stats. No auth. Requires the
// `collection` param (400 if absent). Fans out to get_collection_stats plus a
// query_sql-backed HIGH/MEDIUM coverage computation (both via supabaseAdmin.rpc,
// mocked by name). Happy path enriches the stats with fmv_high_medium_* fields;
// a stats payload carrying an `error` key → 404.

const state: { stats: any; statsError: any; hm: any; throwOnStats: unknown } = {
  stats: { editions: 100 },
  statsError: null,
  hm: [{ high_medium: 50, edition_total: 100 }],
  throwOnStats: null,
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      if (name === "get_collection_stats") {
        if (state.throwOnStats) throw state.throwOnStats
        return { data: state.stats, error: state.statsError }
      }
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
  state.throwOnStats = null
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

  // deep-audit D11. This case used to assert HTTP 200 with an error body, and
  // that contract was the whole bug: the overview page guards with
  // `if (!res.ok) throw`, so 200 passed, the error object became a truthy
  // `stats`, and every KPI fell through `?? 0` — rendering "0 editions" for a
  // collection with 6,190 of them. A failed read must be a failed status.
  it("503s (not 200) when the stats RPC errors, without leaking the driver message", async () => {
    state.statsError = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("30")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.json()
    expect(body.code).toBe("timeout")
    expect(body.retryable).toBe(true)
    // The Postgres text is logged, never published.
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  // The thrown path classifies as `internal` (500), not `timeout` (503) — an
  // unrecognized failure is not assumed retryable. The load-bearing property is
  // only that it is NOT 200.
  it("500s when the stats RPC throws, without leaking the thrown message", async () => {
    state.throwOnStats = new Error("connect ECONNREFUSED 10.0.0.1:5432")
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    const body = await res.json()
    // Unrecognized failures fall back to generic copy — say less, not more.
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED")
    expect(body.error).toBeTruthy()
  })
})
