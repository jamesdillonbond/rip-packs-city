import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/fmv (the sibling only spot-checks). GET is a single edition
// lookup; POST is a batch (<=100). Both resolve external_id→uuid→fmv_snapshots and
// shape the result. Legs pinned: GET no-edition 400, found/404/no-data, serial
// multiplier, includeHistory, editions-error 500; POST bad-json/empty/oversize/
// invalid-entry 400s, the success/error counts, per-edition serial override, and
// the editions-error 500.

const st = vi.hoisted(() => ({
  editions: { data: [] as any[] | null, error: null as any },
  fmv: { data: [] as any[] | null, error: null as any },
  history: { data: [] as any[] | null, error: null as any },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      let limitUsed = false
      const b: any = {
        select: () => b, in: () => b, eq: () => b, order: () => b, limit: () => { limitUsed = true; return b },
        then: (resolve: any) => resolve(table === "editions" ? st.editions : table === "fmv_snapshots" ? (limitUsed ? st.history : st.fmv) : { data: [], error: null }),
      }
      return b
    },
  }),
}))

import { GET, POST } from "@/app/api/fmv/route"

const getReq = (qs: string) => new Request(`https://t/api/fmv${qs}`)
const postReq = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any
const fmvRow = (over: any = {}) => ({ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01T00:00:00Z", liquidity_rating: 3, wap_without_outliers: 90, sales_count_30d: 12, days_since_sale: 2, wap_usd: 95, ...over })

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
  st.editions = { data: [{ id: "E1", external_id: "1:2" }], error: null }
  st.fmv = { data: [fmvRow()], error: null }
  st.history = { data: [], error: null }
})

describe("GET /api/fmv", () => {
  it("400 without an edition param", async () => {
    const res = await GET(getReq(""))
    expect(res.status).toBe(400)
    expect((await res.json()).usage).toBeTruthy()
  })
  it("returns the FMV for a known edition", async () => {
    const res = await GET(getReq("?edition=1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.edition).toBe("1:2")
    expect(body.fmv).toBe(100)
    expect(body.confidence).toBe("high") // lowercased
    expect(body.aspUsd).toBe(95)
    expect(body.aspClean).toBe(90)
  })
  it("404 for an unknown edition", async () => {
    st.editions = { data: [], error: null }
    const res = await GET(getReq("?edition=9:9"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Edition not found")
  })
  it("200 'No FMV data yet' for a known edition with no snapshot", async () => {
    st.fmv = { data: [], error: null }
    const body = await (await GET(getReq("?edition=1:2"))).json()
    expect(body.error).toBe("No FMV data yet")
  })
  it("applies a serial multiplier when ?serial= is given", async () => {
    const body = await (await GET(getReq("?edition=1:2&serial=1"))).json()
    expect(body.serialMult).not.toBeNull()
    expect(body.adjustedFmv).toBeGreaterThan(0)
  })
  it("history=true attaches a priceHistory series", async () => {
    // Query returns DESC (newest first); the route reverses to ascending.
    st.history = { data: [{ fmv_usd: 100, computed_at: "2026-07-01T00:00:00Z", sales_count_30d: 6 }, { fmv_usd: 90, computed_at: "2026-06-30T00:00:00Z", sales_count_30d: 5 }], error: null }
    const body = await (await GET(getReq("?edition=1:2&history=true"))).json()
    expect(Array.isArray(body.priceHistory)).toBe(true)
    expect(body.priceHistory[0].date).toBe("2026-06-30") // reversed to ascending
  })
  it("editions lookup error → 500", async () => {
    st.editions = { data: null, error: { message: "ed down" } }
    expect((await GET(getReq("?edition=1:2"))).status).toBe(500)
  })
})

describe("POST /api/fmv", () => {
  it("400 invalid JSON", async () => { expect((await POST(postReq({}, true))).status).toBe(400) })
  it("400 for a missing/empty editions array", async () => {
    expect((await POST(postReq({}))).status).toBe(400)
    expect((await POST(postReq({ editions: [] }))).status).toBe(400)
  })
  it("400 for >100 editions", async () => {
    expect((await POST(postReq({ editions: Array.from({ length: 101 }, (_, i) => `${i}:1`) }))).status).toBe(400)
  })
  it("400 for an invalid entry shape", async () => {
    expect((await POST(postReq({ editions: [123] }))).status).toBe(400)
  })
  it("batch: counts successes and errors", async () => {
    st.editions = { data: [{ id: "E1", external_id: "1:2" }], error: null } // only 1:2 resolves
    st.fmv = { data: [fmvRow()], error: null }
    const body = await (await POST(postReq({ editions: ["1:2", "9:9"] }))).json()
    expect(body.count).toBe(2)
    expect(body.successCount).toBe(1)
    expect(body.errorCount).toBe(1)
    expect(body.results.find((r: any) => r.edition === "9:9").error).toBe("Edition not found")
  })
  it("honors a per-edition serial override object", async () => {
    const body = await (await POST(postReq({ editions: [{ edition: "1:2", serial: 1 }] }))).json()
    expect(body.results[0].serialMult).not.toBeNull()
  })
  it("editions lookup error → 500", async () => {
    st.editions = { data: null, error: { message: "ed down" } }
    expect((await POST(postReq({ editions: ["1:2"] }))).status).toBe(500)
  })
})
