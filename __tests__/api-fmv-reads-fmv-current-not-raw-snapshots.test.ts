// Deep-audit R3. /api/fmv resolved FMV by selecting raw `fmv_snapshots`
// ordered by computed_at DESC and deduping first-wins in JS — the D27
// anti-pattern already fixed in app/api/alerts and allday-pack-ev.
//
// `fmv_snapshots` keeps daily history (measured 40.7 rows per Top Shot
// edition, max 209) and PostgREST caps ANY read at 1000 rows, including an
// unbounded one. On a realistic 100-edition batch the query yields ~3,702 rows,
// so the window covered 50 of 100 and the rest were reported as "No FMV data
// yet" — a false claim about our own coverage, manufactured from a row cap, on
// the documented product API.
//
// This pins the FIX (the table it reads), not a fixture. A fixture-only test
// is what nearly kept D27's old shape validated.
import { describe, it, expect, vi, beforeEach } from "vitest"

const tablesQueried: string[] = []

const EDITION = { id: "ed-uuid-1", external_id: "73:2785" }
const FMV_ROW = {
  edition_id: "ed-uuid-1",
  fmv_usd: 42,
  confidence: "HIGH",
  computed_at: "2026-08-15T00:00:00Z",
  liquidity_rating: "A",
  wap_without_outliers: 40,
  sales_count_30d: 9,
  days_since_sale: 1,
  wap_usd: 41,
}

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (table: string) => {
    tablesQueried.push(table)
    const payload = () =>
      table === "editions"
        ? { data: [EDITION], error: null }
        : table === "fmv_current"
          ? { data: [FMV_ROW], error: null }
          : { data: [], error: null }
    const b: Record<string, unknown> = {}
    for (const m of ["select", "in", "eq", "order", "limit", "gte", "lte"]) {
      b[m] = () => b
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve(payload())
    return b
  }
  return { createClient: () => ({ from: (t: string) => makeBuilder(t) }) }
})

describe("/api/fmv resolves FMV from fmv_current, not raw fmv_snapshots", () => {
  beforeEach(() => {
    tablesQueried.length = 0
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key"
  })

  it("queries fmv_current and never raw fmv_snapshots for the lookup", async () => {
    const { GET } = await import("@/app/api/fmv/route")
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785") as never)
    expect(res.status).toBe(200)

    expect(tablesQueried).toContain("fmv_current")
    // The only legitimate raw-snapshots read in this route is the bounded
    // 21-row price-history query, which requires &history=1. A plain lookup
    // must not touch the history table at all.
    expect(tablesQueried).not.toContain("fmv_snapshots")
  })

  it("still returns a real FMV (the repoint did not break the contract)", async () => {
    const { GET } = await import("@/app/api/fmv/route")
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785") as never)
    const body = await res.json()
    expect(body.fmv).toBe(42)
    expect(body.confidence).toBe("high")
    expect(body.error).toBeUndefined()
  })

  it("a genuinely unpriced edition still reports 'No FMV data yet'", async () => {
    // The fix must not turn a real coverage gap into a silent zero — the
    // opposite failure. Served by asking for an edition the fmv fixture
    // does not cover.
    const { GET } = await import("@/app/api/fmv/route")
    const res = await GET(new Request("http://t/api/fmv?edition=99:9999") as never)
    const body = await res.json()
    expect(body.error).toBe("Edition not found")
  })
})
