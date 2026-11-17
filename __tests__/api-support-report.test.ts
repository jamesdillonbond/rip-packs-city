import { describe, it, expect, beforeEach, afterAll, vi } from "vitest"

// Route integration test for GET /api/support-report. Bearer INGEST_SECRET_TOKEN
// gated (also accepts ?token= / x-ingest-token) → fail-closed 401. With the
// token present it aggregates support_conversations into a JSON report. Mocks
// @supabase/supabase-js.

const state: {
  data: any
  error: any
  /** Sequential pages, one consumed per read — drives the keyset loop. */
  pages: Array<{ data: any; error: any }> | null
  /** Every cursor passed to .gt("id", …), in order. */
  cursors: string[]
} = { data: [], error: null, pages: null, cursors: [] }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, gte: () => b, not: () => b, order: () => b, limit: () => b,
    gt: (_col: string, v: string) => { state.cursors.push(v); return b },
    // Proper thenable so `await q` resolves whether or not .gt() was chained.
    then: (onF: any, onR: any) => {
      const payload = state.pages
        ? state.pages[Math.min(state.cursors.length, state.pages.length - 1)]
        : { data: state.data, error: state.error }
      return Promise.resolve(payload).then(onF, onR)
    },
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/support-report/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

const prev = process.env.INGEST_SECRET_TOKEN
beforeEach(() => { state.data = []; state.error = null; state.pages = null; state.cursors = []; process.env.INGEST_SECRET_TOKEN = "secret" })
afterAll(() => { if (prev === undefined) delete process.env.INGEST_SECRET_TOKEN; else process.env.INGEST_SECRET_TOKEN = prev })

describe("GET /api/support-report", () => {
  it("401s without the bearer token", async () => {
    const res = await GET(req("https://t/api/support-report"))
    expect(res.status).toBe(401)
  })

  it("401s when the expected token is unset (fail-closed)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await GET(req("https://t/api/support-report", { authorization: "Bearer whatever" }))
    expect(res.status).toBe(401)
  })

  it("returns the aggregated report for an authorized caller", async () => {
    state.data = [
      { session_id: "s1", escalated: false, category: "general", created_at: "2026-07-10T00:00:00Z" },
    ]
    const res = await GET(req("https://t/api/support-report?token=secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.summary.totalMessages).toBe(1)
    expect(body.summary.uniqueSessions).toBe(1)
  })
})

describe("GET /api/support-report — every number is computed over the WHOLE window", () => {
  // 🚨 THIS READ WAS UNBOUNDED and every figure in the report comes from it:
  // totalMessages, uniqueSessions, per-category counts, daily volume, and
  // deflectionRate. PostgREST caps at 1,000 rows with no error and no short
  // page, so past the cap the RATE is computed over a truncated denominator —
  // wrong in an unpredictable direction, not merely low. Measured live
  // 2026-09-02: **666 conversations in the default 7-day window**, two thirds of
  // the way to the cap, and `days` was UNCLAMPED, so `?days=11` already crossed
  // it.

  const PAGE = 1000
  const row = (i: number, over: Record<string, unknown> = {}) => ({
    id: `id-${String(i).padStart(6, "0")}`,
    session_id: `s${i}`,
    escalated: false,
    category: "general",
    created_at: "2026-07-10T00:00:00Z",
    ...over,
  })
  const fullPage = () => Array.from({ length: PAGE }, (_, i) => row(i))

  it("counts rows that only exist on the SECOND page", async () => {
    state.pages = [
      { data: fullPage(), error: null },
      { data: [row(9999, { escalated: true })], error: null },
    ]
    const body = await (await GET(req("https://t/api/support-report?token=secret"))).json()
    expect(body.summary.totalMessages).toBe(PAGE + 1)
    expect(body.summary.escalatedCount).toBe(1)
  })

  it("the deflection RATE uses the full denominator, not the capped one", async () => {
    // 1,000 deflected + 1,000 escalated = 50%. Truncated at the cap it reads
    // 100%, which is a plausible number and therefore the dangerous kind of wrong.
    state.pages = [
      { data: fullPage(), error: null },
      { data: Array.from({ length: PAGE }, (_, i) => row(PAGE + i, { escalated: true })), error: null },
      { data: [], error: null },
    ]
    const body = await (await GET(req("https://t/api/support-report?token=secret"))).json()
    expect(body.summary.totalMessages).toBe(2 * PAGE)
    expect(body.summary.deflectionRate).toBe("50%")
  })

  it("the cursor ADVANCES to the last id of the previous page", async () => {
    state.pages = [
      { data: fullPage(), error: null },
      { data: [row(9999)], error: null },
    ]
    await GET(req("https://t/api/support-report?token=secret"))
    expect(state.cursors).toEqual([`id-${String(PAGE - 1).padStart(6, "0")}`])
  })

  it("NO-CHANGE CONTROL: a SHORT first page stops after one read", async () => {
    state.pages = [
      { data: [row(1)], error: null },
      // Consumed only if the loop wrongly asks for a second page.
      { data: [row(2)], error: null },
    ]
    const body = await (await GET(req("https://t/api/support-report?token=secret"))).json()
    expect(state.cursors).toEqual([])
    expect(body.summary.totalMessages).toBe(1)
  })

  it("a page error 500s rather than reporting a partial window", async () => {
    // ⛔ A partial report is worse than no report: its rate reads plausible.
    state.pages = [
      { data: fullPage(), error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
    ]
    const res = await GET(req("https://t/api/support-report?token=secret"))
    expect(res.status).toBe(500)
  })

  it("still reports escalations newest-first after paging (the walk orders by id, the report by date)", async () => {
    // ⚠ dailyVolume and topCategories sort themselves, so neither can see the
    // row order. `escalatedDetails` is the ONLY order-dependent output — it maps
    // rows as they come — so it is the one that pins the re-sort. The page walk
    // has to order by the PK, which is not the report's order.
    state.pages = [
      {
        data: [
          row(1, { created_at: "2026-07-01T00:00:00Z", escalated: true, session_id: "older" }),
          row(2, { created_at: "2026-07-09T00:00:00Z", escalated: true, session_id: "newer" }),
        ],
        error: null,
      },
    ]
    const body = await (await GET(req("https://t/api/support-report?token=secret"))).json()
    expect(body.escalatedDetails.map((e: { sessionId: string }) => e.sessionId)).toEqual(["newer", "older"])
  })

  it("terminates when the cursor cannot advance, instead of walking to MAX_PAGES", async () => {
    // The pathological case the no-progress guard exists for: an upstream that
    // keeps returning the same full page. Without the guard the loop runs to its
    // page ceiling and totalMessages becomes nonsense rather than merely capped.
    state.pages = [{ data: fullPage(), error: null }]
    const body = await (await GET(req("https://t/api/support-report?token=secret"))).json()
    // Two reads at most: the first page, then the repeat that proves no progress.
    expect(body.summary.totalMessages).toBeLessThanOrEqual(2 * PAGE)
  })
})

describe("GET /api/support-report — the days param", () => {
  it("a non-numeric ?days falls back to 7 instead of throwing on an Invalid Date", async () => {
    // `new Date(NaN).toISOString()` throws a RangeError. Both sibling routes
    // (/api/edition-history, /api/profile/portfolio-history) guard this; this one
    // never got the fix.
    state.data = []
    const res = await GET(req("https://t/api/support-report?token=secret&days=abc"))
    expect(res.status).toBe(200)
    expect((await res.json()).period.days).toBe(7)
  })

  it("clamps ?days to [1, 90]", async () => {
    state.data = []
    expect((await (await GET(req("https://t/api/support-report?token=secret&days=0"))).json()).period.days).toBe(1)
    expect((await (await GET(req("https://t/api/support-report?token=secret&days=9999"))).json()).period.days).toBe(90)
  })
})
