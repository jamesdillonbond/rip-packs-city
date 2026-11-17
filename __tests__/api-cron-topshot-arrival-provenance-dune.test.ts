import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, type RecordedRpcCall } from "./helpers/route-harness"

// GET/POST /api/cron/topshot-arrival-provenance-dune — Dune query 9129294 lane
// that prices held Top Shot moments from their on-chain arrival transaction.
// Pins: auth; an unconfigured proxy is a logged FAILURE (not a quiet skip);
// no targets spends nothing; a configured run executes, stores mapped rows,
// marks every target probed and applies; a refused /execute flips ok=false;
// the dune_budget_state.paused kill switch stops it before Dune (unreadable = fail).

const state = vi.hoisted(() => ({ afterCbs: [] as Array<() => unknown>, sb: null as unknown }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

const { GET, POST } = await import("@/app/api/cron/topshot-arrival-provenance-dune/route")

const TX = "a349d590be19bbff6c639e109abe275a8c2b017990dbd7215896e1275ae03439"
const TARGETS = [
  { wallet: "0x7e38edfe0510024a", nft_id: "25167", fmv_usd: 40 },
  { wallet: "0x8bc1c0249e2ebb3e", nft_id: "99", fmv_usd: 0.5 },
]

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:topshot_arrival_probe_targets": { data: TARGETS, error: null },
    "rpc:apply_topshot_arrival_provenance": { data: { inserted: 1, updated_unknown: 0, usd: 145 }, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    topshot_arrival_provenance: { data: null, error: null },
    topshot_arrival_probed: { data: null, error: null },
    dune_api_usage: { data: null, error: null },
    dune_budget_state: { data: { paused: false }, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}
const req = (auth = "Bearer cron-secret") =>
  new NextRequest("https://t/api/cron/topshot-arrival-provenance-dune", { headers: new Headers(auth ? { authorization: auth } : {}) })
type LogArgs = { p_ok: boolean; p_error: string | null; p_extra: Record<string, unknown> } & Record<string, unknown>
const terminalLog = (calls: RecordedRpcCall[]) =>
  calls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as LogArgs

async function runDeferred() {
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

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => { fetchMock?.restore(); fetchMock = null })
beforeEach(() => {
  state.afterCbs.length = 0
  process.env.CRON_SECRET = "cron-secret"
  process.env.INGEST_SECRET_TOKEN = "ingest"
  process.env.DUNE_PROXY_URL = "https://dune-proxy.example"
  process.env.DUNE_PROXY_SECRET = "s"
})

describe("topshot-arrival-provenance-dune", () => {
  it("401s without the bearer and schedules nothing", async () => {
    install({})
    expect((await GET(req(""))).status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("an unconfigured proxy is logged as a failure, not a quiet success", async () => {
    delete process.env.DUNE_PROXY_URL
    const spy = install({})
    const res = await GET(req())
    expect(res.status).toBe(503)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: false, p_error: "dune_not_configured" })
  })

  it("with no target above the FMV floor it never calls Dune", async () => {
    const spy = install({ "rpc:topshot_arrival_probe_targets": { data: [TARGETS[1]], error: null } })
    fetchMock = installFetchMock([])
    await POST(req())
    await runDeferred()
    expect(fetchMock.calls).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: true })
    expect(terminalLog(spy.rpcCalls).p_extra.skipped_reason).toBe("no_targets")
  })

  it("the shared Dune kill switch stops it before any Dune call", async () => {
    const spy = install({ dune_budget_state: { data: { paused: true }, error: null } })
    fetchMock = installFetchMock([])
    await POST(req())
    await runDeferred()
    expect(fetchMock.calls).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls).p_extra.skipped_reason).toBe("dune_paused")
    expect(spy.writes.topshot_arrival_probed ?? []).toHaveLength(0)
  })

  it("an unreadable kill switch fails the run instead of spending", async () => {
    const spy = install({ dune_budget_state: { data: null, error: { message: "boom" } } })
    fetchMock = installFetchMock([])
    await POST(req())
    await runDeferred()
    expect(fetchMock.calls).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: false })
  })

  it("executes only the targets above the floor, stores rows, marks probed, applies", async () => {
    const spy = install({})
    fetchMock = installFetchMock([
      { match: (u) => u.includes("/execute"), respond: () => ({ json: { execution_id: "e1" } }) },
      { match: (u) => u.includes("/status"), respond: () => ({ json: { state: "QUERY_STATE_COMPLETED" } }) },
      {
        match: (u) => u.includes("/results"),
        respond: () => ({
          json: {
            execution_id: "e1",
            result: { rows: [
              { id: "25167", w: "0x7e38edfe0510024a", dt: "2023-06-01", h: 1, tx: TX, k: "OC", p: "145", f: "0x2ca8ca67324c4ac" },
              { id: "bad", w: "0x7e38edfe0510024a", tx: TX, k: "OC" },
            ] },
            next_offset: null,
          },
        }),
      },
    ])
    await POST(req())
    await runDeferred()
    const exec = fetchMock.calls.find((c) => c.url.includes("/execute"))!
    const body = JSON.parse(String(exec.init?.body))
    expect(body.query_parameters.ids).toBe("25167")
    expect(spy.writes.topshot_arrival_provenance?.length).toBeGreaterThan(0)
    expect(spy.writes.topshot_arrival_probed?.length).toBeGreaterThan(0)
    expect(spy.rpcCalls.some((c) => c.name === "apply_topshot_arrival_provenance")).toBe(true)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_skipped: 1, p_rows_written: 1 })
  })

  it("a refused /execute (query not on the proxy allowlist) flips ok=false and marks nothing probed", async () => {
    const spy = install({})
    fetchMock = installFetchMock([
      { match: (u) => u.includes("/execute"), respond: () => ({ json: { error: "query_id_not_allowed" }, status: 403 }) },
    ])
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_error).toMatch(/execute HTTP 403/)
    expect(spy.writes.topshot_arrival_probed ?? []).toHaveLength(0)
  })
})
