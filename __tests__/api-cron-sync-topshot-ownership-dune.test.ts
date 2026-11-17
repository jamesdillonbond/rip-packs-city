import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for /api/cron/sync-topshot-ownership-dune.
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET
// Fail-closed auth — no auth and a wrong bearer both 401 before any DB/upstream
// work. The route is INERT until DUNE_PROXY_URL + DUNE_PROXY_SECRET +
// DUNE_OWNERSHIP_QUERY_ID are all set: an authed run with those unset returns 202
// {ok, skipped:"dune_not_configured"} WITHOUT any Dune I/O.
//
// The heavy work is after()-deferred. We capture after() (next/server mock),
// configure the Dune env, stub the dune-proxy worker (execute/status/results with
// a headers.get for the 429 backoff), then run the deferred body under fake timers
// (the refresh poll + inter-page paces are multi-second sleeps). supabaseAdmin is a
// Proxy onto an instrumented fixture so log_pipeline_run's p_ok / p_extra can be
// asserted, and topshot_ownership upsert errors are drivable via the fixture.

const state = vi.hoisted(() => ({ afterCbs: [] as Array<() => unknown>, sb: null as any }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }
  ),
}))

import { makeReq } from "./cron-req-helper"

const URL_BASE = "https://t/api/cron/sync-topshot-ownership-dune"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/sync-topshot-ownership-dune/route")
})

// ── Dune spend budget (2026-08-22) ────────────────────────────────────────
// Every lane now asks `dune_budget_status()` before it buys Dune rows, and the
// guard FAILS CLOSED: an unreadable budget authorises nothing. So a suite that
// omits this fixture does not test the walk at all — it tests the budget stop.
// Overridable per test (spread first), which is how the stop paths are driven.
const BUDGET_ALLOWS = {
  "rpc:dune_budget_status": {
    data: {
      configured: true,
      paused: false,
      pipeline_enabled: true,
      can_start: true,
      // Two meters. Datapoints (rows x columns) is what Dune's 1,000,000/cycle
      // limit is denominated in and is what the routes decrement; rows are the
      // secondary per-day bound.
      datapoints_allowed_now: 700000,
      rows_allowed_now: 150000,
      min_start_datapoints: 600000,
      credits_est_left: 2500,
      day_row_cap: 150000,
      rows_today: 0,
    },
    error: null,
  },
} as const

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures = {}) {
  const spy = makeInstrumentedSupabaseFixture({ ...BUDGET_ALLOWS, ...fixtures })
  state.sb = spy.fixture
  return spy
}

function configureDune() {
  process.env.DUNE_PROXY_URL = "https://dune-proxy.test"
  process.env.DUNE_PROXY_SECRET = "proxy-secret"
  process.env.DUNE_OWNERSHIP_QUERY_ID = "q-123"
}

type Resp = {
  status?: number
  ok?: boolean
  json?: unknown
  text?: string
  headers?: Record<string, string>
  throw?: string
}
// Sequenced dune-proxy fetch mock keyed on the endpoint the URL hits. The last
// entry of each list repeats. Includes headers.get so the 429 backoff path works.
function stubDune(routes: { execute?: Resp[]; status?: Resp[]; results?: Resp[] }) {
  const idx: Record<string, number> = { execute: 0, status: 0, results: 0 }
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input)
    const key = url.includes("/execute") ? "execute" : url.includes("/status") ? "status" : "results"
    const list = (routes as any)[key] as Resp[] | undefined
    const r = list && list.length ? list[Math.min(idx[key]++, list.length - 1)] : { status: 200, json: {} }
    if (r.throw) throw new Error(r.throw)
    const status = r.status ?? 200
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      headers: { get: (h: string) => r.headers?.[h.toLowerCase()] ?? null },
      json: async () => r.json ?? {},
      text: async () => r.text ?? "",
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

// Drive the captured after() work to completion under fake timers.
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) {
    let settled = false
    const p = Promise.resolve()
      .then(cb)
      .finally(() => {
        settled = true
      })
    let guard = 0
    while (!settled) {
      if (++guard > 500) throw new Error("runDeferred: after() work did not settle under fake timers")
      await vi.advanceTimersByTimeAsync(30_000)
    }
    await p
  }
}

function logRow(spy: ReturnType<typeof install>) {
  return spy.rpcCalls.find((c) => c.name === "log_pipeline_run")
}

const okRow = (over: Record<string, unknown> = {}) => ({
  nft_id: "n1",
  owner_address: "0xabc",
  set_id: 1,
  play_id: 2,
  serial_number: 5,
  ...over,
})

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
  process.env.CRON_SECRET = "test-cron-secret"
  delete process.env.DUNE_PROXY_URL
  delete process.env.DUNE_PROXY_SECRET
  delete process.env.DUNE_OWNERSHIP_QUERY_ID
  delete process.env.DUNE_OWNERSHIP_INCREMENTAL
  delete process.env.DUNE_OWNERSHIP_BATCH_SETS
  state.afterCbs.length = 0
  install() // default inert fixture (skip-path log_pipeline_run resolves)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("POST /api/cron/sync-topshot-ownership-dune", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.POST(makeReq({ method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/cron/sync-topshot-ownership-dune — inert skip (Dune unconfigured)", () => {
  it("202s with skipped:'dune_not_configured' (INGEST bearer)", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("dune_not_configured")
    expect(body.pipeline).toBe("ownership-sync-dune")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("dune_not_configured")
  })

  it("GET alias reaches the same 202 skip accept when authed", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(202)
  })
})

describe("POST /api/cron/sync-topshot-ownership-dune — configured walk (after body)", () => {
  it("norefresh=1: walks a single page, upserts, and logs ok:true", async () => {
    configureDune()
    const spy = install()
    stubDune({ results: [{ json: { result: { rows: [okRow(), okRow({ nft_id: "n2" })] }, next_offset: null } }] })

    const res = await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    expect(res.status).toBe(202)
    await runDeferred()

    const row = logRow(spy)
    expect(row).toBeDefined()
    expect(row!.args!.p_ok).toBe(true)
    expect(row!.args!.p_rows_found).toBe(2)
    expect(row!.args!.p_rows_written).toBe(2)
    expect((row!.args!.p_extra as any).exhausted).toBe(true)
    expect((row!.args!.p_extra as any).stale_cache).toBe(false)
  })

  it("full refresh: execute -> status COMPLETED -> walk, logs refreshed:true", async () => {
    configureDune()
    const spy = install()
    stubDune({
      execute: [{ status: 200, json: { execution_id: "ex-1" } }],
      status: [
        { json: { state: "QUERY_STATE_EXECUTING" } },
        { json: { state: "QUERY_STATE_COMPLETED" } },
      ],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(true)
    expect((row!.args!.p_extra as any).refreshed).toBe(true)
    expect((row!.args!.p_extra as any).stale_cache).toBe(false)
  })

  it("execute HTTP 402 (credits exhausted): serves stale cache, ok:false, http_status 402", async () => {
    configureDune()
    const spy = install()
    stubDune({
      execute: [{ status: 402 }],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(false)
    const extra = row!.args!.p_extra as any
    expect(extra.stale_cache).toBe(true)
    expect(extra.refresh_http_status).toBe(402)
    expect(extra.refreshed).toBe(false)
  })

  it("execute ok but no execution_id: stale cache, ok:false", async () => {
    configureDune()
    const spy = install()
    stubDune({
      execute: [{ status: 200, json: {} }],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.stale_cache).toBe(true)
    expect(extra.refresh_note).toContain("no execution_id")
  })

  it("status poll HTTP error: notes it, stale cache, ok:false", async () => {
    configureDune()
    const spy = install()
    stubDune({
      execute: [{ status: 200, json: { execution_id: "ex-2" } }],
      status: [{ status: 500 }],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.stale_cache).toBe(true)
    expect(extra.refresh_note).toContain("status HTTP 500")
  })

  it("status poll reports a FAILED execution state: notes it, stale cache", async () => {
    configureDune()
    const spy = install()
    stubDune({
      execute: [{ status: 200, json: { execution_id: "ex-3" } }],
      status: [{ json: { state: "QUERY_STATE_FAILED" } }],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.refresh_note).toContain("QUERY_STATE_FAILED")
    expect(extra.stale_cache).toBe(true)
  })

  it("results page HTTP error: ok:false with a 'dune proxy HTTP' error message", async () => {
    configureDune()
    const spy = install()
    stubDune({ results: [{ status: 500 }] })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(false)
    expect(String(row!.args!.p_error)).toContain("dune proxy HTTP 500")
  })

  it("results 429 then 200: backs off (Retry-After) and completes the walk", async () => {
    configureDune()
    const spy = install()
    const fetchMock = stubDune({
      results: [
        { status: 429, headers: { "retry-after": "1" } },
        { json: { result: { rows: [okRow()] }, next_offset: null } },
      ],
    })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    // At least two results fetches happened (one 429, one 200).
    const resultsCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/results"))
    expect(resultsCalls.length).toBeGreaterThanOrEqual(2)
    expect(logRow(spy)!.args!.p_ok).toBe(true)
  })

  it("upsert error: ok:false with an 'upsert:' error message", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { error: { message: "constraint boom" } } })
    stubDune({ results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }] })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(false)
    expect(String(row!.args!.p_error)).toContain("upsert:")
  })

  it("counts unmappable rows as skipped (missing owner/set/play)", async () => {
    configureDune()
    const spy = install()
    stubDune({
      results: [
        {
          json: {
            result: { rows: [okRow(), { nft_id: "bad-only" }, { owner_address: "0xno-nft" }] },
            next_offset: null,
          },
        },
      ],
    })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const args = logRow(spy)!.args!
    expect(args.p_rows_found).toBe(3)
    expect(args.p_rows_skipped).toBe(2)
    expect(args.p_rows_written).toBe(1)
  })

  it("multi-page: advances the offset across a full page then a short final page", async () => {
    configureDune()
    const spy = install()
    const bigPage = Array.from({ length: 1000 }, (_, i) => okRow({ nft_id: `n${i}` }))
    stubDune({
      results: [
        { json: { result: { rows: bigPage }, next_offset: 1000 } },
        { json: { result: { rows: [okRow({ nft_id: "tail" })] }, next_offset: null } },
      ],
    })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.offset_reached).toBe(1000)
    expect(extra.exhausted).toBe(true)
    expect(logRow(spy)!.args!.p_rows_written).toBe(1001)
  })

  it("incremental mode: pulls backfill target sets and records incremental_sets", async () => {
    configureDune()
    process.env.DUNE_OWNERSHIP_INCREMENTAL = "1"
    const spy = install({
      "rpc:get_ownership_backfill_targets": {
        data: [{ set_id_onchain: 5 }, { set_id_onchain: 6 }],
        error: null,
      },
    })
    stubDune({
      execute: [{ status: 200, json: { execution_id: "ex-inc" } }],
      status: [{ json: { state: "QUERY_STATE_COMPLETED" } }],
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(spy.rpcCalls.some((c) => c.name === "get_ownership_backfill_targets")).toBe(true)
    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.incremental_sets).toEqual([5, 6])
  })

  it("a thrown fetch during the walk is caught and logged ok:false", async () => {
    configureDune()
    const spy = install()
    stubDune({ results: [{ throw: "socket hang up" }] })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(false)
    expect(String(row!.args!.p_error)).toContain("threw:")
  })
})

// ── The Dune spend budget (2026-08-22) ──────────────────────────────────────
// Context: this walk is ~114k rows x 6 columns per full pass, it ran weekly with
// nothing counting it, and on 2026-07-24 a whole billing cycle's datapoints were
// gone by 06:11. Two properties are pinned here — a lane with no allowance buys
// NOTHING (not "less"), and a stale cache is never re-bought.
describe("POST /api/cron/sync-topshot-ownership-dune — spend budget", () => {
  // Starts from the ALLOWING shape so a test says only what it is changing —
  // otherwise a forgotten field silently turns every case into a failed read.
  const budget = (over: Record<string, unknown>) => ({
    "rpc:dune_budget_status": {
      data: { ...BUDGET_ALLOWS["rpc:dune_budget_status"].data, ...over },
      error: null,
    },
  })

  it("no allowance: makes NO Dune request at all and logs an ok budget stop", async () => {
    configureDune()
    const spy = install(
      budget({ datapoints_allowed_now: 0, rows_allowed_now: 0, can_start: false, rows_today: 150000 })
    )
    const fetchFn = stubDune({ results: [{ json: { result: { rows: [okRow()] } } }] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    // Assert the ABSENCE of the purchase. A stopped lane that still calls
    // /execute has not saved anything — /execute is the call that 402s.
    expect(fetchFn).not.toHaveBeenCalled()
    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(true) // paced as configured — not a failure
    const extra = row!.args!.p_extra as any
    expect(extra.budget_stopped).toBe(true)
    expect(extra.budget_read).toBe("ok")
  })

  it("enough budget to SPEND but not to FINISH: refuses to start, buys nothing", async () => {
    // 🚨 The case the whole allocation exists for. One walk is 684,498
    // datapoints of a 1,000,000 cycle; this walk restarts at offset 0 every run,
    // so spending a 300k remainder buys 44% of a walk AND leaves the table
    // capped at the offset reached. A lane whose unit of work is atomic must
    // decline, not truncate.
    configureDune()
    const spy = install(
      budget({ datapoints_allowed_now: 300000, rows_allowed_now: 150000, can_start: false })
    )
    const fetchFn = stubDune({ results: [{ json: { result: { rows: [okRow()] } } }] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(fetchFn).not.toHaveBeenCalled()
    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(true) // deliberate, not a failure
    const extra = row!.args!.p_extra as any
    expect(extra.budget_stopped).toBe(true)
    // ⚠ The reason must distinguish "no budget" from "not enough to finish" —
    // they call for opposite operator actions (wait vs. raise the reservation).
    expect(String(extra.budget_reason)).toContain("needed to start")
    expect(extra.budget_datapoints_allowed).toBe(300000)
  })

  it("paused: the one-row kill switch stops the lane with no Dune request", async () => {
    configureDune()
    const spy = install(
      budget({ paused: true, datapoints_allowed_now: 0, rows_allowed_now: 0, can_start: false })
    )
    const fetchFn = stubDune({ results: [{ json: { result: { rows: [okRow()] } } }] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(fetchFn).not.toHaveBeenCalled()
    expect((logRow(spy)!.args!.p_extra as any).budget_paused).toBe(true)
  })

  it("unreadable budget: buys nothing AND reports ok=false (an unknown state is not a success)", async () => {
    configureDune()
    const spy = install({
      "rpc:dune_budget_status": { data: null, error: { message: "pool timeout" } },
    })
    const fetchFn = stubDune({ results: [{ json: { result: { rows: [okRow()] } } }] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(fetchFn).not.toHaveBeenCalled()
    const row = logRow(spy)
    expect(row!.args!.p_ok).toBe(false)
    expect(String(row!.args!.p_error)).toContain("pool timeout")
    expect((row!.args!.p_extra as any).budget_stopped).toBe(true)
  })

  it("mid-walk exhaustion stops at the page boundary and records where it stopped", async () => {
    configureDune()
    // Exactly one full page of headroom on the datapoint meter: 1000 rows x 5
    // columns. The second page must therefore never be bought.
    const spy = install(budget({ datapoints_allowed_now: 5000, rows_allowed_now: 1000 }))
    const fullPage = Array.from({ length: 1000 }, (_, i) => okRow({ nft_id: `n${i}` }))
    stubDune({
      results: [
        { json: { result: { rows: fullPage }, next_offset: 1000 } },
        { json: { result: { rows: [okRow({ nft_id: "tail" })] }, next_offset: null } },
      ],
    })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const row = logRow(spy)
    const extra = row!.args!.p_extra as any
    expect(row!.args!.p_rows_found).toBe(1000) // the second page was never bought
    expect(extra.budget_stopped).toBe(true)
    expect(extra.exhausted).toBe(false) // and it does NOT claim it finished
    expect(extra.offset_reached).toBe(1000)
  })

  it("writes one ledger row per results page, with the exact rows and columns bought", async () => {
    configureDune()
    const spy = install(budget({}))
    stubDune({ results: [{ json: { result: { rows: [okRow(), okRow({ nft_id: "n2" })] }, next_offset: null } }] })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?norefresh=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    const ledger = (spy.writes.dune_api_usage ?? []).flatMap((w) => w.rows)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      pipeline: "ownership-sync-dune",
      endpoint: "results",
      rows_returned: 2,
      columns_returned: 5, // okRow(): nft_id, owner_address, set_id, play_id, serial_number
      datapoints_est: 10,
    })
  })
})

describe("POST /api/cron/sync-topshot-ownership-dune — the stale-cache walk is not re-bought", () => {
  // A failed refresh means /results returns the SAME execution the last run
  // already ingested. Walking it cost a full ~114k-row purchase and wrote rows
  // byte-identical to the previous run's (measured 08-10 and 08-17).
  const stale402 = { execute: [{ status: 402 }] }
  const probe = (total: number | null, rows = [okRow()]) => ({
    json: { result: { rows, ...(total === null ? {} : { metadata: { total_row_count: total } }) } },
  })

  it("skips the walk when we already hold the whole cached execution", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { data: null, error: null, count: 5 } })
    const fetchFn = stubDune({ ...stale402, results: [probe(5)] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    const resultsCalls = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/results"))
    expect(resultsCalls).toHaveLength(1) // the limit=1 size probe, and nothing else
    expect(String(resultsCalls[0][0])).toContain("limit=1")
    expect(spy.writes.topshot_ownership ?? []).toHaveLength(0)
    const row = logRow(spy)
    expect((row!.args!.p_extra as any).walk_skipped).toBe("stale_cache_already_ingested")
    expect(row!.args!.p_ok).toBe(false) // still honest: the run accomplished nothing
  })

  it("BOOTSTRAP CONTROL: an empty table still walks, so the skip cannot strand a first run", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { data: null, error: null, count: 0 } })
    stubDune({ ...stale402, results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect((spy.writes.topshot_ownership ?? []).flatMap((w) => w.rows)).toHaveLength(1)
    expect((logRow(spy)!.args!.p_extra as any).walk_skipped).toBeUndefined()
  })

  it("TRUNCATED-INGEST CONTROL: holding fewer rows than the execution resumes the walk", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { data: null, error: null, count: 2 } })
    stubDune({
      ...stale402,
      results: [probe(9), { json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect((spy.writes.topshot_ownership ?? []).flatMap((w) => w.rows)).toHaveLength(1)
    const extra = logRow(spy)!.args!.p_extra as any
    expect(extra.walk_skipped).toBeUndefined()
    expect(extra.dune_rows_held).toBe(2)
    expect(extra.cached_total_rows).toBe(9)
  })

  it("an unreadable row count skips rather than spends — `?? 0` there would buy the whole walk", async () => {
    configureDune()
    const spy = install({
      topshot_ownership: { data: null, error: { message: "pool timeout" }, count: null },
    })
    const fetchFn = stubDune({ ...stale402, results: [probe(5)] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(fetchFn.mock.calls.filter((c) => String(c[0]).includes("/results"))).toHaveLength(0)
    expect((logRow(spy)!.args!.p_extra as any).walk_skipped).toBe("stale_cache_row_count_unreadable")
  })

  it("an unreadable cached size skips too (cannot prove the walk would add a row)", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { data: null, error: null, count: 5 } })
    stubDune({ ...stale402, results: [probe(null)] })

    await mod.POST(makeReq({ method: "POST", url: URL_BASE, auth: "Bearer test-ingest-token" }))
    await runDeferred()

    expect(spy.writes.topshot_ownership ?? []).toHaveLength(0)
    expect((logRow(spy)!.args!.p_extra as any).walk_skipped).toBe("stale_cache_size_unknown")
  })

  it("?forcewalk=1 is the operator override and walks anyway", async () => {
    configureDune()
    const spy = install({ topshot_ownership: { data: null, error: null, count: 5 } })
    stubDune({
      ...stale402,
      results: [{ json: { result: { rows: [okRow()] }, next_offset: null } }],
    })

    await mod.POST(
      makeReq({ method: "POST", url: `${URL_BASE}?forcewalk=1`, auth: "Bearer test-ingest-token" })
    )
    await runDeferred()

    expect((spy.writes.topshot_ownership ?? []).flatMap((w) => w.rows)).toHaveLength(1)
    expect((logRow(spy)!.args!.p_extra as any).walk_skipped).toBeUndefined()
  })
})
