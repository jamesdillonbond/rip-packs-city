import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-stats. No auth. Requires the
// `collection` param (400 if absent). Reads EVERYTHING from one
// `get_collection_stats` RPC — including the HIGH/MEDIUM FMV share, which this
// route used to recompute for itself with a second, byte-equivalent per-edition
// scan. A stats payload carrying an `error` key → 404.

const state: { stats: any; statsError: any; throwOnStats: unknown } = {
  stats: { editions: 100 },
  statsError: null,
  throwOnStats: null,
}

/** Every RPC name the route asks for, in order. Pins the ONE-PASS property. */
const rpcCalls: string[] = []

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      rpcCalls.push(name)
      if (name === "get_collection_stats") {
        if (state.throwOnStats) throw state.throwOnStats
        return { data: state.stats, error: state.statsError }
      }
      return { data: null, error: null }
    },
  },
}))

import { GET } from "@/app/api/collection-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.stats = { editions: 100 }
  state.statsError = null
  state.throwOnStats = null
  rpcCalls.length = 0
})

describe("GET /api/collection-stats", () => {
  it("400s when the collection param is missing", async () => {
    const res = await GET(req("https://t/api/collection-stats"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("collection param required")
  })

  it("serves the HIGH/MEDIUM FMV share straight off the stats payload", async () => {
    state.stats = { editions: 100, fmv_high_medium_count: 50, fmv_high_medium_pct: 50 }
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editions).toBe(100)
    expect(body.fmv_high_medium_count).toBe(50)
    expect(body.fmv_high_medium_pct).toBe(50)
  })

  // ⛔ THE PROPERTY THIS FIX EXISTS FOR, asserted as an ABSENCE rather than as a
  // faster number. The route used to run a second `query_sql` scan that was
  // byte-equivalent to work `get_collection_stats` had already done — 116,945
  // buffers / 2,875 ms / 19,942 lateral loops on Top Shot, measured in the QUIET
  // band. A `Promise.all` hid it in wall-clock; the database paid the sum.
  // A timing assertion could not see this. The call list can.
  it("makes exactly one RPC call — no second per-edition scan", async () => {
    state.stats = { editions: 100, fmv_high_medium_count: 50, fmv_high_medium_pct: 50 }
    await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(rpcCalls).toEqual(["get_collection_stats"])
    expect(rpcCalls).not.toContain("query_sql")
  })

  // ⚠ Zero is a REAL value here — UFC Strike's HIGH/MEDIUM share is genuinely
  // 0.0% — so it must survive as 0 and never be nulled or defaulted away.
  it("preserves a genuine zero share rather than collapsing it to null", async () => {
    state.stats = { editions: 518, fmv_high_medium_count: 0, fmv_high_medium_pct: 0 }
    const body = await (await GET(req("https://t/api/collection-stats?collection=ufc-strike"))).json()
    expect(body.fmv_high_medium_count).toBe(0)
    expect(body.fmv_high_medium_pct).toBe(0)
  })

  // The other half of the same contract: NOT MEASURED must be distinguishable
  // from MEASURED AS ZERO. An absent key would vanish from the JSON entirely,
  // and the consumer would read `undefined` — so it is normalized to an explicit
  // null, which the overview page renders as no claim at all.
  it("renders an absent share as an explicit null, not as a missing key", async () => {
    state.stats = { editions: 100, fmv_pct: 87.3 }
    const body = await (await GET(req("https://t/api/collection-stats?collection=laliga-golazos"))).json()
    expect("fmv_high_medium_count" in body).toBe(true)
    expect(body.fmv_high_medium_count).toBeNull()
    expect(body.fmv_high_medium_pct).toBeNull()
    // ⛔ And it must NOT be backfilled from `fmv_pct`, which is a different and
    // much larger metric: 87.3% coverage against a true 0.3% priced-from-sales.
    expect(body.fmv_high_medium_pct).not.toBe(87.3)
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

  // ⚠ INVERTED 2026-09-18, NOT LOOSENED — and the reason matters more than the
  // number. This asserted 500 with the comment "an unrecognized failure is not
  // assumed retryable", which was CORRECT at the time: `connect ECONNREFUSED
  // …:5432` matched nothing in `safeApiError`. It is no longer unrecognized. A
  // refused connection to the database port is a TRANSPORT failure — the same
  // class as the Cloudflare 522 that put every public board route on a
  // non-retryable 500 during the 2026-09-18 Supabase outage (#122), which is
  // the defect `upstream_unavailable` was added to fix. Recognising it IS the
  // fix, so the expected status moves 500 → 503.
  //
  // ⭐ THE TWO LOAD-BEARING PROPERTIES ARE UNCHANGED AND STILL ASSERTED: the
  // status is NOT 200 (deep-audit D11 — a failed read must be a failed status,
  // or the overview page renders "0 editions" for a collection with 6,190), and
  // the driver message is NEVER published. The control below keeps the original
  // "unrecognized is not assumed retryable" claim alive for the case it still
  // describes, so widening the transport match to a bare substring reddens here.
  it("503s (not 200) when the stats RPC throws a transport failure, without leaking the thrown message", async () => {
    state.throwOnStats = new Error("connect ECONNREFUSED 10.0.0.1:5432")
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).not.toBe(200)
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("30")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.json()
    expect(body.code).toBe("upstream_unavailable")
    expect(body.retryable).toBe(true)
    // Recognized or not, the driver text is logged and never published.
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED")
    expect(JSON.stringify(body)).not.toContain("10.0.0.1")
    expect(body.error).toBeTruthy()
  })

  // THE CONTROL. A failure that really IS unrecognized must still be a
  // non-retryable 500 — otherwise the inversion above would read as licence to
  // call everything transient, which fails OPEN.
  it("CONTROL — a genuinely unrecognized throw is still a non-retryable 500", async () => {
    state.throwOnStats = new Error("could not assemble the stats payload")
    const res = await GET(req("https://t/api/collection-stats?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
