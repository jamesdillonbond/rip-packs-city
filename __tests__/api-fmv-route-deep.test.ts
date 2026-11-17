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
  // 2026-10-10 (#18): the fitted serial premium, one batch call per request
  serial: { data: [] as any[] | null, error: null as any },
  serialCalls: [] as any[],
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    // The FMV lookup is get_editions_latest_fmv_wide since 2026-09-20 — same payload the
    // fmv_current table key served, so st.fmv drives both the RPC and the history read.
    rpc: async (name: string, args: any) => {
      if (name === "get_editions_latest_fmv_wide") return st.fmv
      if (name === "serial_fmv_multiplier_batch") { st.serialCalls.push(args); return st.serial }
      return { data: [], error: null }
    },
    from(table: string) {
      let limitUsed = false
      const b: any = {
        select: () => b, in: () => b, eq: () => b, order: () => b, limit: () => { limitUsed = true; return b },
        then: (resolve: any) => resolve(table === "editions" ? st.editions : (table === "fmv_snapshots" || table === "fmv_current") ? (limitUsed ? st.history : st.fmv) : { data: [], error: null }),
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
  st.serial = { data: [{ edition_id: "E1", serial: 1, multiplier: 7.66, basis: "first" }], error: null }
  st.serialCalls = []
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
  // 2026-10-10 (#18, RE-PINNED: the premise changed). The serial premium is the FITTED
  // model (serial_fmv_multiplier_batch -> serial_fmv_estimate), not lib/fmv/serial-multiplier's
  // flat bands, which a 4,477-sale backtest put at roughly twice the error.
  it("applies the fitted serial multiplier when ?serial= is given", async () => {
    const body = await (await GET(getReq("?edition=1:2&serial=1"))).json()
    expect(body.serialMult).toBe(7.66)
    expect(body.serialBasis).toBe("first")
    expect(body.adjustedFmv).toBe(766)
    // one batch call, carrying the edition uuid, the serial and the base FMV
    expect(st.serialCalls).toEqual([{ p_items: [{ edition_id: "E1", serial: 1, fmv: 100, confidence: "HIGH" }] }])
  })
  it("no serial asked for -> no premium read at all, and adjustedFmv = fmv", async () => {
    const body = await (await GET(getReq("?edition=1:2"))).json()
    expect(st.serialCalls).toEqual([])
    expect(body.serialMult).toBeNull()
    expect(body.adjustedFmv).toBe(100)
  })
  it("the model's 'no premium' is 1x; an unplaceable circulation is null, never a guessed 1x", async () => {
    st.serial = { data: [{ edition_id: "E1", serial: 7, multiplier: 1, basis: "no_premium" }], error: null }
    const a = await (await GET(getReq("?edition=1:2&serial=7"))).json()
    expect(a.serialMult).toBe(1)
    st.serial = { data: [{ edition_id: "E1", serial: 500, multiplier: null, basis: "circulation_unknown" }], error: null }
    const b = await (await GET(getReq("?edition=1:2&serial=500"))).json()
    expect(b.serialMult).toBeNull()
    expect(b.serialBasis).toBe("circulation_unknown")
    expect(b.adjustedFmv).toBe(100)
  })
  it("a FAILED premium read is a failure, never the unadjusted FMV presented as premium-free", async () => {
    st.serial = { data: null, error: { message: "estimator down" } }
    const get = await GET(getReq("?edition=1:2&serial=1"))
    expect(get.status).toBe(500)
    const post = await POST(postReq({ editions: [{ edition: "1:2", serial: 1 }] }))
    expect(post.status).toBe(500)
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
    expect(body.results[0].serialMult).toBe(7.66)
    expect(body.results[0].serialBasis).toBe("first")
    expect(st.serialCalls).toEqual([{ p_items: [{ edition_id: "E1", serial: 1, fmv: 100, confidence: "HIGH" }] }])
  })
  it("editions lookup error → 500", async () => {
    st.editions = { data: null, error: { message: "ed down" } }
    expect((await POST(postReq({ editions: ["1:2"] }))).status).toBe(500)
  })
})
