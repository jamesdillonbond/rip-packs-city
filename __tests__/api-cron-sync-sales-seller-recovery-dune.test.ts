import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET/POST /api/cron/sync-sales-seller-recovery-dune — the Dune
// sales seller-recovery walker. Pins:
//   - INERT skip when unconfigured logs skipped:'dune_not_configured' (no walk);
//   - a configured run reads the backward date-window cursor, executes the saved
//     query per window, pages /results, maps rows, fills via
//     apply_sales_counterparty_external, and advances the cursor to the window start;
//   - rows with a malformed seller are skipped, not fatal;
//   - an execute-HTTP failure flips ok=false;
//   - a /results HTTP error flips ok=false;
//   - an apply RPC error flips ok=false;
//   - the auth guard (401 before any after() work).
//
// The route always refreshes (execute->poll->results), so the after() walk is
// driven under fake timers to fast-forward the poll/inter-page sleeps.

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

const { GET, POST } = await import("@/app/api/cron/sync-sales-seller-recovery-dune/route")

const PROXY = "https://dune-proxy.example"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    // one 7-day window that reaches the floor -> loop drains after a single pass
    sales_seller_recovery_state: {
      data: { cursor_end: "2020-01-08", floor_date: "2020-01-01", window_days: 7 },
      error: null,
    },
    "rpc:apply_sales_counterparty_external": { data: { applied: 2 }, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(method: "GET" | "POST" = "GET", auth = "Bearer dune-token"): NextRequest {
  return new NextRequest("https://t/api/cron/sync-sales-seller-recovery-dune", {
    method,
    headers: new Headers(auth ? { authorization: auth } : {}),
  })
}

// Run the deferred after() callbacks while fast-forwarding all timers.
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
  return rpcCalls.filter((c) => c.name === "apply_sales_counterparty_external")
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
  delete process.env.DUNE_SALES_SELLER_QUERY_ID
})
function configure() {
  process.env.DUNE_PROXY_URL = PROXY
  process.env.DUNE_PROXY_SECRET = "dune-secret"
  process.env.DUNE_SALES_SELLER_QUERY_ID = "8027085"
}

describe("sync-sales-seller-recovery-dune — auth + inert", () => {
  it("401s without an authorization header (fail-closed, no after work)", async () => {
    install({})
    const res = await GET(req("GET", ""))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("401s with a wrong bearer token", async () => {
    install({})
    const res = await POST(req("POST", "Bearer nope"))
    expect(res.status).toBe(401)
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

describe("sync-sales-seller-recovery-dune — configured walk", () => {
  it("executes a window, fills mapped rows, advances the cursor, drains", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: {
          rows: [
            { transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac", collection: "nba_top_shot" },
            { transaction_hash: "bb", nft_id: "1002", seller: "0xf06746d6d596ba89", collection: "nfl_all_day" },
          ],
        },
        next_offset: null,
      }),
    ])

    const res = await POST(req("POST"))
    expect(res.status).toBe(202)
    await runDeferredFast()

    // execute -> status -> results all hit
    expect(fetchMock.calls.some((c) => c.url.includes("/execute"))).toBe(true)
    expect(fetchMock.calls.some((c) => c.url.includes("/status"))).toBe(true)
    // apply called once with the two mapped rows (lowercased seller passthrough)
    const applies = applyCalls(spy.rpcCalls)
    expect(applies).toHaveLength(1)
    expect((applies[0].args as any).p_rows).toHaveLength(2)
    expect((applies[0].args as any).p_rows[0]).toMatchObject({ tx_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac" })
    // cursor advanced to the window start (2020-01-01) and drained
    const updates = spy.writes.sales_seller_recovery_state ?? []
    expect(updates.at(-1)?.rows[0]).toMatchObject({ cursor_end: "2020-01-01" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 2 })
    expect(log.p_extra).toMatchObject({ drained: true, windows_done: 1 })
  })

  it("skips rows with a malformed seller without failing the run", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: {
          rows: [
            { transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac" }, // ok
            { transaction_hash: "bb", nft_id: "1002", seller: "not-an-address" }, // skipped
            { transaction_hash: "cc", nft_id: "1003" }, // no seller -> skipped
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
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 3, p_rows_skipped: 2 })
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

  it("a /results HTTP error flips ok=false", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([executeRoute(), statusRoute(), resultsRoute({}, { status: 502 })])
    await POST(req("POST"))
    await runDeferredFast()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("dune proxy HTTP 502")
  })

  it("an apply RPC error flips ok=false", async () => {
    configure()
    const spy = install({
      "rpc:apply_sales_counterparty_external": { data: null, error: { message: "boom" } },
    })
    fetchMock = installFetchMock([
      executeRoute(),
      statusRoute(),
      resultsRoute({
        result: { rows: [{ transaction_hash: "aa", nft_id: "1001", seller: "0xbd94cade097e50ac" }] },
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
