import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// THE INVOCATION MARKER MUST BE WRITTEN BEFORE THE WORK — behaviourally, not by
// grep.
//
// `__tests__/after-route-heartbeat-ratchet.test.ts` counts which `after()` routes
// CALL `writeInvocationHeartbeat`. That is a static read, and it is satisfied by
// a call placed anywhere in the callback — including after the work, where the
// marker cannot survive the kill it exists to record. The whole contract is the
// ORDERING, and the ratchet is structurally blind to it.
//
// ⚠ THIS IS THE SHAPE THIS REPO KEEPS PAYING FOR: a guard that asserts the
// PRESENCE of a thing rather than the PROPERTY that makes it work. So these
// tests assert the marker lands before the FIRST `log_pipeline_run` of the tick,
// off one interleaved event log rather than two separate recorders — two arrays
// cannot see an ordering between them.
//
// ⚠ A marker cannot detect its own kill and no test can simulate one. What is
// testable is everything the correlation query depends on:
//   * the row is written FIRST;
//   * under `<pipeline>-heartbeat`, never the real name (a marker under the real
//     name refreshes `last_run` every tick and silences
//     `detect_stalled_pipelines()` on precisely the outage it exposes);
//   * `finished_at === started_at`, so `duration_ms` (GENERATED from the pair)
//     is a hard 0 rather than this INSERT's own latency;
//   * `rows_* === null`, never 0 — a marker measures nothing, and a 0 there is
//     the `?? 0` fabrication class in telemetry. A retirement sweep read exactly
//     that and concluded a live pipeline was inert.
//
// Covers the three routes converted 2026-09-02, chosen on measured margin
// against their own walls (see the ratchet's eighth entry).
// ─────────────────────────────────────────────────────────────────────────────

interface Ev {
  kind: "insert" | "rpc"
  name: string
}

/** One interleaved log. `from(t).insert()` and `rpc(name)` both land here. */
function recorder() {
  const events: Ev[] = []
  const rows: Record<string, unknown>[] = []
  const rpcArgs: Record<string, Record<string, unknown> | undefined> = {}
  const db = {
    from(table: string) {
      const b: {
        insert: (r: unknown) => Promise<{ error: null }>
        select: () => typeof b
        eq: () => typeof b
        then: (resolve: (v: unknown) => unknown) => unknown
      } = {
        insert: async (r: unknown) => {
          events.push({ kind: "insert", name: table })
          rows.push(r as Record<string, unknown>)
          return { error: null }
        },
        select: () => b,
        eq: () => b,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      }
      return b
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      events.push({ kind: "rpc", name })
      rpcArgs[name] = args
      if (name === "get_allday_lock_refresh_wallets") return { data: [], error: null }
      if (name === "populate_pinnacle_wmc_fmv") return { data: { examined: 3, updated: 1 }, error: null }
      return { data: null, error: null }
    },
  }
  return { db, events, rows, rpcArgs }
}

/** The assertions every converted route owes, in one place. */
function assertMarkerContract(
  rec: ReturnType<typeof recorder>,
  pipeline: string,
) {
  // ORDERING — the property the static ratchet cannot see. The marker must
  // precede the first terminal write of the tick, not merely exist.
  const firstInsert = rec.events.findIndex((e) => e.kind === "insert" && e.name === "pipeline_runs")
  const firstLog = rec.events.findIndex((e) => e.kind === "rpc" && e.name === "log_pipeline_run")
  expect(firstInsert, "no pipeline_runs marker was written at all").toBeGreaterThanOrEqual(0)
  expect(firstLog, "the route wrote no terminal row, so this tick proves nothing").toBeGreaterThanOrEqual(0)
  expect(
    firstInsert,
    `the marker landed at event ${firstInsert} and the terminal row at ${firstLog}; a marker ` +
      `written after the work cannot survive the kill it exists to record`,
  ).toBeLessThan(firstLog)

  const marker = rec.rows[0]
  // ⚠ The SUFFIX, asserted against the real name — not merely "ends with
  // -heartbeat". A marker written under `pipeline` itself would refresh
  // `last_run` on the watchlist and hide the outage.
  expect(marker.pipeline).toBe(`${pipeline}-heartbeat`)
  expect(marker.pipeline).not.toBe(pipeline)
  // A hard 0 duration, so nobody reads this INSERT's latency as a run time.
  expect(marker.finished_at).toBe(marker.started_at)
  // NULL, never 0 — the column DEFAULTS to 0, so omitting these publishes a
  // measurement nobody took.
  expect(marker.rows_found).toBeNull()
  expect(marker.rows_written).toBeNull()
  expect(marker.rows_skipped).toBeNull()
  // Never ok:false — the run has not failed, it has not finished, and an
  // ok:false marker would inflate v_pipeline_failure_rates.
  expect(marker.ok).toBe(true)
}

let deferred: Array<() => unknown> = []

beforeEach(() => {
  vi.resetModules()
  deferred = []
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.CRON_SECRET = "tok"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k"
})

function mockAfter() {
  vi.doMock("next/server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("next/server")>()
    return { ...actual, after: (cb: () => unknown) => void deferred.push(cb) }
  })
}

async function runDeferred() {
  const cbs = [...deferred]
  deferred.length = 0
  for (const cb of cbs) await cb()
}

const authed = (url: string) =>
  new Request(url, { method: "POST", headers: { authorization: "Bearer tok" } })

/** ⚠ Some of these handlers read `req.nextUrl`, which a plain `Request` does not
 *  have — it throws `Cannot read properties of undefined (reading 'searchParams')`
 *  before the marker is ever written, which reads like a missing call. */
const authedNext = (url: string, method = "POST") =>
  new NextRequest(url, { method, headers: new Headers({ authorization: "Bearer tok" }) })

describe("cron/allday-lock-refresh-batch writes its marker first", () => {
  it("marker precedes the terminal row, under the suffixed name", async () => {
    const rec = recorder()
    mockAfter()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: rec.db }))
    vi.doMock("@/lib/allday-lock", () => ({
      refreshAllDayWalletLocks: async () => ({
        total_cached: 0,
        marked_locked: 0,
        marked_unlocked: 0,
      }),
    }))
    const { POST } = await import("@/app/api/cron/allday-lock-refresh-batch/route")

    const res = await POST(authed("https://t/api/cron/allday-lock-refresh-batch") as never)
    // The 202 is returned BEFORE the marker exists — which is exactly why the
    // marker matters: the caller has already been told this succeeded.
    expect(res.status).toBe(202)
    await runDeferred()

    assertMarkerContract(rec, "allday-lock-refresh")
    // ⚠ NO-CHANGE CONTROL for the extra payload: the soft deadline is the whole
    // reason this route runs at 90%+ of its wall, so it must be readable off the
    // marker without opening the source at the version that was deployed.
    expect((rec.rows[0].extra as Record<string, unknown>).soft_deadline_ms).toBe(270_000)
  })
})

describe("cron/populate-pinnacle-wmc-fmv writes its marker first", () => {
  it("marker precedes the terminal row, under the suffixed name", async () => {
    const rec = recorder()
    mockAfter()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: rec.db }))
    const { POST } = await import("@/app/api/cron/populate-pinnacle-wmc-fmv/route")

    const res = await POST(authed("https://t/api/cron/populate-pinnacle-wmc-fmv") as never)
    expect(res.status).toBe(202)
    await runDeferred()

    assertMarkerContract(rec, "populate-pinnacle-wmc-fmv")
    // The terminal row still reports the RPC's real counters — the marker did
    // not displace or overwrite them.
    const log = rec.rpcArgs["log_pipeline_run"] as Record<string, unknown>
    expect(log.p_ok).toBe(true)
    expect(log.p_rows_written).toBe(1)
  })

  it("POSITIVE CONTROL — an unauthorized call writes NO marker", async () => {
    // Without this, a route that wrote the marker before its auth check would
    // pass every assertion above while letting an unauthenticated caller fill
    // `pipeline_runs` with markers for ticks that never ran.
    const rec = recorder()
    mockAfter()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: rec.db }))
    const { POST } = await import("@/app/api/cron/populate-pinnacle-wmc-fmv/route")

    const res = await POST(
      new Request("https://t/api/cron/populate-pinnacle-wmc-fmv", { method: "POST" }) as never,
    )
    expect(res.status).toBe(401)
    await runDeferred()
    expect(rec.events).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The 2026-09-02 second batch, selected on margin against each route's OWN wall
// rather than on watchlist membership — the watchlisted tier no longer holds the
// routes at risk.
//
// ⚠ Two of these build their OWN supabase client with `createClient` instead of
// importing `lib/supabase`, so the helper's `db` argument is passed explicitly.
// That is a real failure mode, not a style point: the helper's DEFAULT would
// write through a different connection, and a test that only mocked
// `@/lib/supabase` would see no marker and could not tell that from a missing
// call. Each case below mocks the module the route actually uses.
// ─────────────────────────────────────────────────────────────────────────────

describe("cron/resolve-topshot-stubs writes its marker first", () => {
  it("marker precedes the terminal row — the smallest wall in the fleet, 30s", async () => {
    const rec = recorder()
    mockAfter()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: rec.db }))
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }),
    })))
    const { POST } = await import("@/app/api/cron/resolve-topshot-stubs/route")

    // ⓘ 200, not 202 — this route answers OK and does its work in after()
    //   anyway, which is precisely why a kill here is invisible.
    const res = await POST(authedNext("https://t/api/cron/resolve-topshot-stubs") as never)
    expect(res.status).toBe(200)
    await runDeferred()

    assertMarkerContract(rec, "resolve-topshot-stubs")
    vi.unstubAllGlobals()
  })
})

describe("check-alerts writes its marker first", () => {
  it("🚨 the ALERTING route — a killed tick's output is silence, so the marker is the only evidence", async () => {
    const rec = recorder()
    mockAfter()
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: rec.db }))
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }),
    })))
    // ⚠ This route exports GET, not POST — cron-job.org pings it with a GET.
    const { GET } = await import("@/app/api/check-alerts/route")

    const res = await GET(authedNext("https://t/api/check-alerts", "GET") as never)
    expect(res.status).toBe(202)
    await runDeferred()

    assertMarkerContract(rec, "check-alerts")
    vi.unstubAllGlobals()
  })
})

describe("cron/alerts-send writes its marker first — through its OWN client", () => {
  it("marker precedes the terminal row when the route builds its own createClient", async () => {
    const rec = recorder()
    mockAfter()
    // ⚠ THE POINT OF THIS CASE. The route never imports `@/lib/supabase`, so the
    // helper is called with an explicit `db`. Mock the module it DOES use; if the
    // explicit argument were dropped, the marker would go to a client this test
    // never sees and `rec.events` would be empty.
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => rec.db }))
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }),
    })))
    const { POST } = await import("@/app/api/cron/alerts-send/route")

    // ⚠ NextRequest, because the handler reads `req.nextUrl.searchParams`.
    const res = await POST(authedNext("https://t/api/cron/alerts-send") as never)
    expect(res.status).toBe(202)
    await runDeferred()

    assertMarkerContract(rec, "alerts-send")
    vi.unstubAllGlobals()
  })
})

describe("cron/refresh-conflated-editions writes its marker first — through its OWN client", () => {
  it("marker precedes the terminal row on a 120s wall the job already runs two thirds of", async () => {
    const rec = recorder()
    mockAfter()
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => rec.db }))
    const { POST } = await import("@/app/api/cron/refresh-conflated-editions/route")

    const res = await POST(authedNext("https://t/api/cron/refresh-conflated-editions") as never)
    expect(res.status).toBe(202)
    await runDeferred()

    assertMarkerContract(rec, "refresh-conflated-editions")
  })
})
