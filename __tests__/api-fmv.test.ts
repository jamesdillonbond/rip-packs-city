import { describe, it, expect, beforeEach, vi } from "vitest"

// Integration-test proof-of-concept for a route handler. Establishes the
// reusable pattern for testing app/api/* routes without a live DB: mock
// @supabase/supabase-js so createClient() returns a chainable query builder
// whose awaited result is fixture data keyed by table name. Because /api/fmv
// constructs its client INSIDE the handler, the mock fully controls it.
//
// The public /api/fmv contract (documented in CLAUDE.md) is:
//   { fmv, serialMult, adjustedFmv, confidence, updatedAt, ... }
// These assertions pin the response shape + the serial-premium application +
// the request-validation and not-found status codes.

// Per-table fixture payloads, set in each test. Referenced at call time inside
// the mock factory (not import time), so hoisting is not a problem.
const fmvMock: Record<string, { data: any; error: any }> = {}

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (table: string) => {
    const payload = () => fmvMock[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b,
      in: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      // Thenable: `await supabase.from(t).select().in()` resolves to payload.
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  return {
    createClient: () => ({ from: (table: string) => makeBuilder(table) }),
  }
})

// Imported AFTER vi.mock so the route's createClient is the mock.
import { GET, POST } from "@/app/api/fmv/route"

function setMock(payloads: Record<string, { data: any; error?: any }>) {
  for (const k of Object.keys(fmvMock)) delete fmvMock[k]
  for (const [table, p] of Object.entries(payloads)) {
    fmvMock[table] = { data: p.data, error: p.error ?? null }
  }
}

const EDITION = { id: "uuid-1", external_id: "73:2785" }
function snapshot(over: Record<string, any> = {}) {
  return {
    edition_id: "uuid-1",
    fmv_usd: 100,
    confidence: "HIGH",
    computed_at: "2026-07-12T00:00:00Z",
    liquidity_rating: 5,
    wap_without_outliers: 98,
    sales_count_30d: 12,
    days_since_sale: 1,
    wap_usd: 99,
    ...over,
  }
}

beforeEach(() => setMock({}))

describe("GET /api/fmv — validation", () => {
  it("400s with usage when the edition param is missing", async () => {
    const res = await GET(new Request("http://t/api/fmv"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("Missing required parameter: edition")
    expect(body.usage).toBeDefined()
  })
})

describe("GET /api/fmv — lookup outcomes", () => {
  it("404s when the edition external_id is not found", async () => {
    setMock({ editions: { data: [] } })
    const res = await GET(new Request("http://t/api/fmv?edition=99:99"))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("Edition not found")
    expect(body.fmv).toBe(0)
  })

  it("200s with 'No FMV data yet' when the edition exists but has no snapshot", async () => {
    setMock({ editions: { data: [EDITION] }, fmv_snapshots: { data: [] } })
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBe("No FMV data yet")
    expect(body.fmv).toBe(0)
  })

  it("returns the documented FMV shape for a priced edition (no serial)", async () => {
    setMock({ editions: { data: [EDITION] }, fmv_snapshots: { data: [snapshot()] } })
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      edition: "73:2785",
      fmv: 100,
      serialMult: null,
      adjustedFmv: 100,
      confidence: "high", // lower-cased from HIGH
      fallbackTier: "rpc_fmv",
      aspUsd: 99,
      aspClean: 98,
      salesCount30d: 12,
    })
  })

  it("applies the serial multiplier: #1 serial → 12× the base FMV", async () => {
    setMock({ editions: { data: [EDITION] }, fmv_snapshots: { data: [snapshot()] } })
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785&serial=1"))
    const body = await res.json()
    expect(body.serialMult).toBe(12)
    expect(body.adjustedFmv).toBe(1200)
  })

  it("applies the low-serial tier: serial ≤ 10 → 4.5×", async () => {
    setMock({ editions: { data: [EDITION] }, fmv_snapshots: { data: [snapshot()] } })
    const res = await GET(new Request("http://t/api/fmv?edition=73:2785&serial=5"))
    const body = await res.json()
    expect(body.serialMult).toBe(4.5)
    expect(body.adjustedFmv).toBe(450)
  })
})

describe("POST /api/fmv — batch validation", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(
      new Request("http://t/api/fmv", { method: "POST", body: "{not json" })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s on an empty editions array", async () => {
    const res = await POST(
      new Request("http://t/api/fmv", {
        method: "POST",
        body: JSON.stringify({ editions: [] }),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("non-empty editions array")
  })

  it("400s on more than 100 editions", async () => {
    const res = await POST(
      new Request("http://t/api/fmv", {
        method: "POST",
        body: JSON.stringify({ editions: Array.from({ length: 101 }, (_, i) => `k${i}`) }),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Maximum 100 editions")
  })
})
