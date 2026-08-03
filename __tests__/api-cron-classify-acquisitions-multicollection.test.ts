import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/classify-acquisitions-multicollection.
// Data seam: supabaseAdmin from @/lib/supabase. Auth compares the Bearer token
// to a MODULE-captured `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""`, so we
// exercise BOTH regimes by resetting modules between them:
//   A. secret DELETED → TOKEN === "" → every request 401s (fail-closed `!TOKEN`).
//   B. secret SET      → wrong/no token 401s, correct token reaches the 202
//      { ok, accepted, pipeline } accept. The 3-collection classify loop is
//      after()-deferred; after() is stubbed no-op so the accept is observable
//      without any DB I/O.

const cap = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
const cst = vi.hoisted(() => ({
  bySlug: {} as Record<string, any>,
  runs: [] as any[],
  logThrows: false,
  calls: [] as Array<{ slug: string; limit: number; since: string | null }>,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { cap.fn = fn } }
})
// Factory must be self-contained: vi.mock is hoisted above any module-scope
// const, so the stub is built inside it (TDZ otherwise).
vi.mock("@/lib/supabase", () => {
  const sb: any = {}
  for (const m of ["from","select","eq","in","order","limit","gte","lte","lt","gt","is","not","or","range","match","insert","update","upsert","delete","returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: {}, error: null })
  sb.maybeSingle = async () => ({ data: {}, error: null })
  const BY_ID: Record<string, string> = {
    "dee28451-5d62-409e-a1ad-a83f763ac070": "nfl_all_day",
    "06248cc4-b85f-47cd-af67-1855d14acd75": "laliga_golazos",
    "9b4824a8-736d-4a96-b450-8dcc0c46b023": "ufc_strike",
  }
  sb.rpc = async (name: string, args: any) => {
    if (name === "log_pipeline_run") {
      if (cst.logThrows) throw new Error("log down")
      cst.runs.push(args)
      return { data: null, error: null }
    }
    const slug = BY_ID[args?.p_collection_id] ?? "unknown"
    cst.calls.push({ slug, limit: args?.p_limit, since: args?.p_since ?? null })
    const outcome = cst.bySlug[slug]
    if (outcome === undefined) return { data: { scanned: 10, classified: 8, skipped: 2 }, error: null }
    if (outcome === "throw") throw new Error(`${slug} exploded`)
    return outcome
  }
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { supabaseAdmin: sb, supabase: sb }
})

const url = "https://t/api/cron/classify-acquisitions-multicollection"

describe("POST /api/cron/classify-acquisitions-multicollection — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/cron/classify-acquisitions-multicollection/route")
    POST = mod.POST as any
  })

  it("401s fail-closed with no secret configured and no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s fail-closed even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })
})

describe("POST /api/cron/classify-acquisitions-multicollection — secret configured (success path)", () => {
  const TOKEN = "classify-ingest-token"
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/cron/classify-acquisitions-multicollection/route")
    POST = mod.POST as any
  })

  it("401s with no authorization header", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong-token" }))).status).toBe(401)
  })

  it("202s and reports accepted with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.accepted).toBe(true)
    expect(body.pipeline).toBe("classify-acquisitions-multicollection")
  })
})

// --- the after() classify loop: per-collection tallies + failure isolation ---

describe("POST /api/cron/classify-acquisitions-multicollection — deferred classify loop", () => {
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = "loop-token"
    POST = (await import("@/app/api/cron/classify-acquisitions-multicollection/route")).POST as any
  })

  // The route logs TWICE per tick: a synchronous `phase:"invoked"` marker before
  // any work (so a dropped after() is distinguishable from a cron that never
  // fired), then the terminal tally inside after(). Assertions below are about
  // the TERMINAL row, so select it explicitly by shape rather than by index —
  // indexing would silently start asserting against the marker.
  async function run() {
    cst.runs = []
    cst.calls = []
    cap.fn = null
    await POST(makeReq({ url, method: "POST", auth: "Bearer loop-token" }))
    expect(cap.fn).toBeTypeOf("function")
    await cap.fn!()
    const terminal = cst.runs.filter((r) => r?.p_extra?.phase !== "invoked")
    expect(terminal).toHaveLength(1)
    return terminal[0]
  }

  beforeEach(() => {
    cst.bySlug = {}
    cst.logThrows = false
  })

  it("classifies all three collections and sums the tallies", async () => {
    const run1 = await run()
    expect(run1.p_pipeline).toBe("classify-acquisitions-multicollection")
    expect(run1.p_ok).toBe(true)
    expect(run1.p_error).toBeNull()
    expect(run1.p_rows_found).toBe(30)   // 3 x scanned 10
    expect(run1.p_rows_written).toBe(24) // 3 x classified 8
    expect(run1.p_rows_skipped).toBe(6)  // 3 x skipped 2
    expect(Object.keys(run1.p_extra.per_collection)).toEqual([
      "nfl_all_day", "laliga_golazos", "ufc_strike",
    ])
  })

  it("caps AllDay at 80/tick and uses the 500 default elsewhere", async () => {
    await run()
    expect(cst.calls.map((c) => ({ slug: c.slug, limit: c.limit }))).toEqual([
      { slug: "nfl_all_day", limit: 80 },
      { slug: "laliga_golazos", limit: 500 },
      { slug: "ufc_strike", limit: 500 },
    ])
  })

  // Regression guard for the 2026-08-03 timeout fix. The All Day candidate scan
  // drives off the partitioned `sales` table oldest-first, so WITHOUT a sold_at
  // bound it burned the fn's 90s statement_timeout proving the ~612k already
  // classified 2022-2025 rows were empty and died before reaching current data
  // (measured: unbounded TIMEOUT, 45d 34.8s, 14d 3.5s). Dropping p_since here
  // silently restores the hang, so pin that All Day gets a window and that the
  // other two stay unbounded.
  it("passes a bounded sold_at window for the two expensive collections", async () => {
    const before = Date.now()
    await run()
    const after = Date.now()

    const byslug = Object.fromEntries(cst.calls.map((c) => [c.slug, c.since]))
    // Golazos is 0.2s unbounded — it keeps draining its full history.
    expect(byslug.laliga_golazos).toBeNull()

    // All Day (was a TIMEOUT) and UFC (68.3s/tick on a market closed since
    // 2026-05-13) must both be windowed, or the after() loop reclaims enough of
    // the 120s maxDuration to be killed before log_pipeline_run again.
    const DAY = 24 * 60 * 60 * 1000
    for (const slug of ["nfl_all_day", "ufc_strike"]) {
      expect(typeof byslug[slug]).toBe("string")
      const since = Date.parse(byslug[slug] as string)
      expect(Number.isNaN(since)).toBe(false)
      expect(since).toBeGreaterThanOrEqual(before - 14 * DAY - 1000)
      expect(since).toBeLessThanOrEqual(after - 14 * DAY + 1000)
    }
  })

  // The whole point of the marker: a tick that dies inside after() must still
  // leave evidence it was invoked, so a slow query can never be misread as a
  // cron that never fired.
  it("writes a synchronous invoked-marker before any classify work", async () => {
    cst.runs = []
    cst.calls = []
    cap.fn = null
    await POST(makeReq({ url, method: "POST", auth: "Bearer loop-token" }))

    // after() has NOT run yet — this is the state a killed lambda leaves behind.
    expect(cst.calls).toEqual([])
    expect(cst.runs).toHaveLength(1)
    expect(cst.runs[0].p_pipeline).toBe("classify-acquisitions-multicollection")
    expect(cst.runs[0].p_extra).toEqual({ phase: "invoked" })
  })

  it("accepts the alternate RPC counter key names", async () => {
    cst.bySlug = {
      nfl_all_day: { data: { rows_found: 5, rows_written: 4, rows_skipped: 1 }, error: null },
      laliga_golazos: { data: { scanned: 1, inserted: 1, skipped: 0 }, error: null },
      ufc_strike: { data: {}, error: null },
    }
    const r = await run()
    expect(r.p_rows_found).toBe(6)
    expect(r.p_rows_written).toBe(5)
    expect(r.p_rows_skipped).toBe(1)
  })

  it("isolates a per-collection RPC error — the others still classify", async () => {
    cst.bySlug = { laliga_golazos: { data: null, error: { message: "golazos down" } } }
    const r = await run()
    expect(r.p_ok).toBe(false)
    expect(r.p_error).toBe("laliga_golazos: golazos down")
    expect(r.p_extra.per_collection.laliga_golazos).toEqual({ ok: false, error: "golazos down" })
    // the other two still contributed
    expect(r.p_rows_found).toBe(20)
    expect(r.p_extra.per_collection.ufc_strike.ok).toBe(true)
  })

  it("isolates a thrown RPC the same way", async () => {
    cst.bySlug = { ufc_strike: "throw" }
    const r = await run()
    expect(r.p_ok).toBe(false)
    expect(r.p_error).toBe("ufc_strike: ufc_strike exploded")
    expect(r.p_extra.per_collection.ufc_strike.ok).toBe(false)
    expect(r.p_rows_found).toBe(20)
  })

  it("keeps only the FIRST error when several collections fail", async () => {
    cst.bySlug = {
      nfl_all_day: { data: null, error: { message: "allday down" } },
      ufc_strike: "throw",
    }
    const r = await run()
    expect(r.p_error).toBe("nfl_all_day: allday down")
    expect(r.p_ok).toBe(false)
  })

  it("swallows a log_pipeline_run failure without escaping after()", async () => {
    cst.logThrows = true
    cap.fn = null
    await POST(makeReq({ url, method: "POST", auth: "Bearer loop-token" }))
    await expect(cap.fn!()).resolves.toBeUndefined()
  })
})
