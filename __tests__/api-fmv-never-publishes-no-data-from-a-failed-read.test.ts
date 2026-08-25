import { describe, it, expect, beforeEach, vi } from "vitest"

// HONESTY CANON — /api/fmv and /api/fmv/demo are the DOCUMENTED PUBLIC PRODUCT
// API, and both cache their answer at the CDN (`max-age=300` and `max-age=3600`
// respectively). Three reads in those two files destructured only `data` and
// dropped `error`:
//
//   1. GET  /api/fmv   — the chunked `fmv_current` read in `lookupEditions`
//   2. POST /api/fmv   — the same read, fanned out through `Promise.all`
//   3. GET  /api/fmv/demo — the `editions` read that keys every sample
//
// supabase-js RESOLVES on a query error rather than throwing, so in each case
// the failure left `data` null, the code below read that as "there is no row",
// and the route published a CLAIM about our own coverage — `fmv: 0`,
// `confidence: "unknown"`, `error: "No FMV data yet"`, `sampleCount: 0` — at
// HTTP 200, then cached it. R3 had already fixed the SAME false string when a
// PostgREST row cap manufactured it; the failed-read cause was left standing.
//
// The POST leg is the worst of the three: a chunk is 50 editions of up to 100,
// so one failed chunk does not fail the request — it mixes unreadable editions
// in with genuinely uncovered ones and counts both into `errorCount`, and no
// caller can tell them apart.
//
// WHAT THIS PINS is the PROPERTY, not the spelling: the response must never
// carry the no-data claim when the underlying read failed. Asserting the
// ABSENCE of the false claim (rather than the PRESENCE of some error message)
// is what CLAUDE.md's canon asks for, and it survives a rewording of the copy.

const st = vi.hoisted(() => ({
  editions: { data: [] as unknown[] | null, error: null as unknown },
  fmv: { data: [] as unknown[] | null, error: null as unknown },
  history: { data: [] as unknown[] | null, error: null as unknown },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      let limitUsed = false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b, in: () => b, eq: () => b, order: () => b,
        limit: () => { limitUsed = true; return b },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (resolve: any) => resolve(
          table === "editions"
            ? st.editions
            : (table === "fmv_snapshots" || table === "fmv_current")
              ? (limitUsed ? st.history : st.fmv)
              : { data: [], error: null }
        ),
      }
      return b
    },
  }),
}))

import { GET, POST } from "@/app/api/fmv/route"

const getReq = (qs: string) => new Request(`https://t/api/fmv${qs}`)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const postReq = (body: any) => ({ json: async () => body }) as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fmvRow = (over: any = {}) => ({
  edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01T00:00:00Z",
  liquidity_rating: 3, wap_without_outliers: 90, sales_count_30d: 12, days_since_sale: 2,
  wap_usd: 95, ...over,
})

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
  st.editions = { data: [{ id: "E1", external_id: "1:2" }], error: null }
  st.fmv = { data: [fmvRow()], error: null }
  st.history = { data: [], error: null }
})

describe("GET /api/fmv — a failed fmv_current read is not an answer", () => {
  it("does NOT publish 'No FMV data yet' when the fmv_current read errored", async () => {
    st.fmv = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(getReq("?edition=1:2"))
    const body = await res.json()

    // The property: the false coverage claim must be absent.
    expect(JSON.stringify(body)).not.toContain("No FMV data yet")
    // And the fabricated number with it — a failed read must not price at $0.
    expect(body.fmv).not.toBe(0)
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("still reports a genuinely uncovered edition as 'No FMV data yet' at 200 — the two states stay distinct", async () => {
    // Positive control. Without this the test above is satisfiable by a route
    // that simply never emits the string, which would be a different defect.
    st.fmv = { data: [], error: null }
    const res = await GET(getReq("?edition=1:2"))
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe("No FMV data yet")
  })

  it("does not leak the driver message on the failed read", async () => {
    st.fmv = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const body = await (await GET(getReq("?edition=1:2"))).json()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })
})

describe("GET /api/fmv?history=true — a failed history read is not an empty series", () => {
  it("flags the series as unavailable rather than omitting it silently", async () => {
    st.history = { data: null, error: { message: "history down" } }
    const res = await GET(getReq("?edition=1:2&history=true"))
    const body = await res.json()

    // The FMV itself resolved, so the request is NOT fatal…
    expect(res.status).toBe(200)
    expect(body.fmv).toBe(100)
    // …but "could not read the series" must be distinguishable from "no series".
    expect(body.priceHistoryUnavailable).toBe(true)
    expect(body.priceHistory).toBeUndefined()
  })

  it("a genuinely empty series carries no unavailable flag — positive control", async () => {
    st.history = { data: [], error: null }
    const body = await (await GET(getReq("?edition=1:2&history=true"))).json()
    expect(body.priceHistoryUnavailable).toBeUndefined()
  })
})

describe("POST /api/fmv — one failed chunk cannot be laundered into errorCount", () => {
  it("fails the batch instead of reporting the unreadable editions as uncovered", async () => {
    st.editions = { data: [{ id: "E1", external_id: "1:2" }], error: null }
    st.fmv = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await POST(postReq({ editions: ["1:2"] }))
    const body = await res.json()

    expect(JSON.stringify(body)).not.toContain("No FMV data yet")
    expect(body.errorCount).toBeUndefined() // no counts published off a failed read
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("a batch mixing a priced edition with an unresolvable one still answers 200 — positive control", async () => {
    st.editions = { data: [{ id: "E1", external_id: "1:2" }], error: null }
    st.fmv = { data: [fmvRow()], error: null }
    const res = await POST(postReq({ editions: ["1:2", "9:9"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.successCount).toBe(1)
    expect(body.errorCount).toBe(1)
  })
})
