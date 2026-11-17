import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/edition-history driving the real body:
// param guard, edition external_id -> uuid resolve, the fmv_snapshots window
// query, the empty-history branch, and the day-bucketing + current-snapshot
// assembly. Supabase seam via makeSupabaseFixture (fresh per createClient call).

const fx = vi.hoisted(() => ({ tables: {} as Record<string, { data?: unknown; error?: unknown }> }))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeSupabaseFixture(fx.tables),
}))

const { GET } = await import("@/app/api/edition-history/route")

const get = (qs: string) => new NextRequest(`https://t/api/edition-history${qs}`)

beforeEach(() => {
  fx.tables = {}
})

describe("GET /api/edition-history — integration", () => {
  it("400s when the edition param is missing or malformed", async () => {
    expect((await GET(get(""))).status).toBe(400)
    expect((await GET(get("?edition=noColon"))).status).toBe(400)
  })

  it("404s when the edition external_id resolves to no row", async () => {
    fx.tables = { editions: { data: null } }
    const res = await GET(get("?edition=1:2"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Edition not found")
  })

  it("returns an empty history when the edition has no snapshots", async () => {
    fx.tables = { editions: { data: { id: "e1" } }, fmv_snapshots: { data: [] } }
    const res = await GET(get("?edition=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.history).toEqual({ days: [], values: [], sampleSizes: [], aspClean: [] })
    expect(body.current).toBeNull()
  })

  it("500s when the snapshot query errors", async () => {
    fx.tables = { editions: { data: { id: "e1" } }, fmv_snapshots: { error: { message: "boom" } } }
    const res = await GET(get("?edition=1:2"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("boom")
  })

  it("builds the current snapshot + day buckets from today's snapshot", async () => {
    const nowIso = new Date().toISOString()
    fx.tables = {
      editions: { data: { id: "e1" } },
      fmv_snapshots: {
        data: [
          {
            fmv_usd: 10,
            wap_usd: 9,
            wap_without_outliers: 8.5,
            floor_price_usd: 7,
            confidence: "high",
            liquidity_rating: 4,
            sales_count_30d: 5,
            days_since_sale: 1,
            computed_at: nowIso,
          },
        ],
      },
    }
    const res = await GET(get("?edition=1:2&days=7"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.snapshotsFound).toBe(1)
    expect(body.current.fmv).toBe(10)
    expect(body.current.confidence).toBe("HIGH") // upper-cased
    expect(body.history.values).toContain(10)
  })
})
