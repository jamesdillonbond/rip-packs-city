import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET/POST /api/cron/sync-sales-ingest-dune — the Dune pre-2026 TS
// sale-INGEST walker (inserts missing sale rows). Pins:
//   - INERT skip when unconfigured logs skipped:'dune_not_configured' (no walk);
//   - a configured run reads the backward date-window cursor, executes the saved
//     query per window, pages /results, maps rows, inserts via
//     apply_sales_ingest_external, accumulates its counts, advances the cursor;
//   - rows missing price/sold_at (or with a non-positive price) are skipped, not fatal;
//   - an execute-HTTP failure flips ok=false;
//   - the auth guard (401 before any after() work).

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

const { GET, POST } = await import("@/app/api/cron/sync-sales-ingest-dune/route")

const PROXY = "https://dune-proxy.example"

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
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    ...BUDGET_ALLOWS,
    sales_ingest_state: {
      data: { cursor_end: "2020-01-08", floor_date: "2020-01-01", window_days: 7 },
      error: null,
    },
    "rpc:apply_sales_ingest_external": {
      data: { inserted: 2, filled: 0, skipped_unresolved: 0, skipped_existing: 0, skipped_multimoment: 0 },
      error: null,
    },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(method: "GET" | "POST" = "GET", auth = "Bearer dune-token"): NextRequest {
  return new NextRequest("https://t/api/cron/sync-sales-ingest-dune", {
    method,
    headers: new Headers(auth ? { authorization: auth } : {}),
  })
}

async function runDeferredFast() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  vi.useFakeTimers()
  try {
    const done = Promise.all(cbs.map((cb) => cb()))
    await vi.advanceTimersByTimeAsync(900_000)
    await done
  } finally {
    vi.useRealTimers()
  }
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}
function applyCalls(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "apply_sales_ingest_external")
}

function executeRoute(opts: { status?: number; execId?: string } = {}): FetchStub {
  return {
    match: (url) => url.includes("/execute"),
    respond: () => ({ json: { execution_id: opts.execId ?? "exec-1" }, status: opts.status }),
  }
}
function statusRoute(stateStr = "QUERY_STATE_COMPLETED"): FetchStub {
  return { match: (url) => url.includes("/status"), respond: () => ({ json: { state: stateStr } }) }
}
function resultsRoute(json: unknown, opts: { status?: number } = {}): FetchStub {
  return { match: (url) => url.includes("/results"), respond: () => ({ json, status: opts.status }) }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
  process.env.INGEST_SECRET_TOKEN = "dune-token"
  process.env.CRON_SECRET = "cron-secret"
  delete process.env.DUNE_PROXY_URL
  delete process.env.DUNE_PROXY_SECRET
  delete process.env.DUNE_SALES_INGEST_QUERY_ID
})
function configure() {
  process.env.DUNE_PROXY_URL = PROXY
  process.env.DUNE_PROXY_SECRET = "dune-secret"
  process.env.DUNE_SALES_INGEST_QUERY_ID = "8030177"
}

describe("sync-sales-ingest-dune — auth + inert", () => {
  it("401s without an authorization header (fail-closed, no after work)", async () => {
    install({})
    const res = await GET(req("GET", ""))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("202 skipped:'dune_not_configured' when unconfigured (no walk)", async () => {
    const spy = install({})
    const res = await GET(req())
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("dune_not_configured")
    expect(terminalLog(spy.rpcCalls).p_extra).toMatchObject({ skipped: "dune_not_configured" })
    expect(state.afterCbs).toHaveLength(0)
  })

  it("accepts CRON_SECRET as the bearer too", async () => {
    install({})
    const res = await GET(req("GET", "Bearer cron-secret"))
    expect(res.status).toBe(202)
  })
})

describe("sync-sales-ingest-dune — configured walk", () => {
  it("executes a window, inserts mapped rows, advances the cursor, drains", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: {
          rows: [
            { transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac", buyer: null, price_usd: "5", sold_at: "2020-01-05 10:00:00 UTC" },
            { transaction_hash: "bb", nft_id: "1002", seller: "0xf06746d6d596ba89", buyer: null, price_usd: "12", sold_at: "2020-01-06 10:00:00 UTC" },
          ],
        },
        next_offset: null,
      }),
    ])

    const res = await POST(req("POST"))
    expect(res.status).toBe(202)
    await runDeferredFast()

    expect(fetchMock.calls.some((c) => c.url.includes("/execute"))).toBe(true)
    const applies = applyCalls(spy.rpcCalls)
    expect(applies).toHaveLength(1)
    expect((applies[0].args as any).p_rows).toHaveLength(2)
    expect((applies[0].args as any).p_rows[0]).toMatchObject({ tx_hash: "aa", nft_id: "1001", price_usd: "5" })
    const updates = spy.writes.sales_ingest_state ?? []
    expect(updates.at(-1)?.rows[0]).toMatchObject({ cursor_end: "2020-01-01" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 2 })
    expect(log.p_extra).toMatchObject({ inserted: 2, drained: true, windows_done: 1 })
  })

  it("skips rows missing price/sold_at or with a non-positive price, without failing", async () => {
    configure()
    const spy = install({
      "rpc:apply_sales_ingest_external": {
        data: { inserted: 1, filled: 0, skipped_unresolved: 0, skipped_existing: 0, skipped_multimoment: 0 },
        error: null,
      },
    })
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: {
          rows: [
            { transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac", price_usd: "5", sold_at: "2020-01-05 10:00:00 UTC" }, // ok
            { transaction_hash: "bb", nft_id: "1002", seller: "0xf06746d6d596ba89", price_usd: "0", sold_at: "2020-01-06 10:00:00 UTC" }, // price 0 -> skipped
            { transaction_hash: "cc", nft_id: "1003", seller: "0xf06746d6d596ba89", sold_at: "2020-01-06 10:00:00 UTC" }, // no price -> skipped
          ],
        },
        next_offset: null,
      }),
    ])

    await POST(req("POST"))
    await runDeferredFast()

    const applies = applyCalls(spy.rpcCalls)
    expect((applies[0].args as any).p_rows).toHaveLength(1)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.map_skipped).toBe(2)
  })

  it("an execute HTTP failure flips ok=false", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([executeRoute({ status: 500 }), statusRoute(), resultsRoute({})])
    await POST(req("POST"))
    await runDeferredFast()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("execute HTTP 500")
  })

  it("an apply RPC error flips ok=false", async () => {
    configure()
    const spy = install({
      "rpc:apply_sales_ingest_external": { data: null, error: { message: "boom" } },
    })
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: { rows: [{ transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac", price_usd: "5", sold_at: "2020-01-05 10:00:00 UTC" }] },
        next_offset: null,
      }),
    ])
    await POST(req("POST"))
    await runDeferredFast()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("apply: boom")
  })
})

// ── The Dune spend budget (2026-08-22) ──────────────────────────────────────
// ⚠ THIS IS THE LANE THAT BURNED THE 2026-07-24 CYCLE — ~636,956 rows across 37
// windows before Dune refused, 90.2% of them discarded on arrival. Its Vercel
// schedule was retired on 07-28 and the route deliberately KEPT, so the guard is
// pinned here now: the day someone re-adds the cron is the day it would
// otherwise repeat, and that is exactly when nobody is looking for a budget bug.
describe("sync-sales-ingest-dune — spend budget", () => {
  it("no allowance: buys nothing, does not advance the cursor, stays ok", async () => {
    configure()
    const spy = install({
      "rpc:dune_budget_status": {
        data: {
          ...BUDGET_ALLOWS["rpc:dune_budget_status"].data,
          datapoints_allowed_now: 0,
          rows_allowed_now: 0,
          can_start: false,
        },
        error: null,
      },
    })
    fetchMock = installFetchMock([executeRoute(), statusRoute(), resultsRoute({})])

    await POST(req("POST"))
    await runDeferredFast()

    expect(fetchMock.calls).toHaveLength(0)
    expect(spy.writes.sales_ingest_state ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.budget_stopped).toBe(true)
  })

  it("unreadable budget: buys nothing and reports ok=false", async () => {
    configure()
    const spy = install({
      "rpc:dune_budget_status": { data: null, error: { message: "pool timeout" } },
    })
    fetchMock = installFetchMock([executeRoute(), statusRoute(), resultsRoute({})])

    await POST(req("POST"))
    await runDeferredFast()

    expect(fetchMock.calls).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("pool timeout")
  })
})
