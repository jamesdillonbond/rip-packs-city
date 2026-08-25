import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/edition-history. No auth gate. Mocks
// @supabase/supabase-js createClient with a per-table thenable/single builder:
// editions .select().eq().single() resolves the external_id → UUID; fmv_snapshots
// .select().eq().gte().order() is awaited for the daily rows. Pins the `edition`
// 400 guards, the 404-when-edition-missing path, and the empty-history 200.

const tables: Record<string, { data: any; error?: any }> = {}

vi.mock("@supabase/supabase-js", () => {
  const builder = (table: string) => {
    const payload = () => tables[table] ?? { data: null, error: null }
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      order: () => b,
      single: async () => payload(),
      // The route resolves the edition with .maybeSingle() so that "no such
      // edition" and "the read failed" land in different channels — .single()
      // raises PGRST116 on zero rows and merges them. The mock has to offer it.
      maybeSingle: async () => payload(),
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => builder(t) }) }
})

import { GET } from "@/app/api/edition-history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe("GET /api/edition-history", () => {
  it("400s without an edition param", async () => {
    const res = await GET(req("https://t/api/edition-history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("edition param required")
  })

  it("400s when edition has no colon", async () => {
    const res = await GET(req("https://t/api/edition-history?edition=nocolon"))
    expect(res.status).toBe(400)
  })

  it("404s when the edition is not found", async () => {
    tables.editions = { data: null }
    const res = await GET(req("https://t/api/edition-history?edition=218:8217"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Edition not found")
  })

  // HONESTY CANON — the same instance already fixed in /api/edition-stats and
  // /api/collection-series. The edition resolve used to swallow its `error` and
  // branch on `!editionRow?.id`, so a FAILED read rendered 404 "Edition not
  // found" — a claim about our own catalogue, on a public entity surface. The
  // 404 case directly above is the positive control: absent must still 404.
  it("does not 404 'Edition not found' when the edition read errored", async () => {
    tables.editions = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("https://t/api/edition-history?edition=218:8217"))
    expect(res.status).not.toBe(404)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("Edition not found")
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("returns empty history when there are no snapshots", async () => {
    tables.editions = { data: { id: "uuid-1" } }
    tables.fmv_snapshots = { data: [], error: null }
    const res = await GET(req("https://t/api/edition-history?edition=218:8217&days=21"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.edition).toBe("218:8217")
    expect(body.history.values).toEqual([])
    expect(body.current).toBeNull()
  })

  // Regression: a present-but-non-numeric ?days (or a bare unbounded one) must
  // NOT 500. parseInt("abc") is NaN and Math.min/Math.max do not sanitize NaN,
  // so an unguarded clamp made days=NaN → since.setUTCDate(x - NaN) = Invalid
  // Date → since.toISOString() threw RangeError. This route is public
  // (proxy.ts PUBLIC_READ_APIS) and has no try/catch, so that was an
  // anon-reachable crash. The guard degrades to the default 21.
  it.each(["abc", "", "NaN", "1e999", "-5", "999"])(
    "degrades a bad ?days=%s to a clamped default instead of 500ing",
    async (bad) => {
      tables.editions = { data: { id: "uuid-1" } }
      tables.fmv_snapshots = { data: [], error: null }
      const res = await GET(req(`https://t/api/edition-history?edition=218:8217&days=${bad}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      // Non-numeric/empty → default 21; numeric extremes → clamped to [1,90].
      expect(Number.isFinite(body.days)).toBe(true)
      expect(body.days).toBeGreaterThanOrEqual(1)
      expect(body.days).toBeLessThanOrEqual(90)
    },
  )
})
