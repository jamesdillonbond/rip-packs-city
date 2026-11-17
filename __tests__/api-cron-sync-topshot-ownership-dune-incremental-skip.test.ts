import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Handoff docs/handoff-2026-08-22-dune-ownership-incremental.md, items 1 + 2.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// In incremental mode `executeBody` stayed undefined when `batchSets` came back
// empty, and the code below sent an /execute with NO query_parameters. On this
// query that is the FULL walk: 146,100 rows x 6 columns = 876,600 datapoints,
// 87.7% of the 1,000,000-datapoint cycle.
//
// So the two states that should be CHEAPEST - the backfill is finished, or the
// targets RPC threw - were the two that bought the single most expensive run the
// account can make. The catch around the RPC already swallows the error into
// refreshNote and falls straight through, so a transient DB error was one
// unlucky tick away from spending the month.

const state = vi.hoisted(() => ({ sb: null as any, afterCbs: [] as Array<() => unknown> }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => { state.afterCbs.push(cb) } }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({} as any, { get: (_t, k) => (state.sb as any)[k] }),
}))

const { GET } = await import("@/app/api/cron/sync-topshot-ownership-dune/route")
const PROXY = "https://dune-proxy.example"

const BUDGET_ALLOWS = {
  "rpc:dune_budget_status": {
    data: {
      configured: true,
      paused: false,
      pipeline_enabled: true,
      can_start: true,
      datapoints_allowed_now: 900000,
      rows_allowed_now: 150000,
      min_start_datapoints: 880000,
      credits_est_left: 2500,
    },
    error: null,
  },
} as const

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const spy = makeInstrumentedSupabaseFixture({
    ...BUDGET_ALLOWS,
    topshot_ownership: { data: null, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/sync-topshot-ownership-dune", {
    method: "GET",
    headers: new Headers({ authorization: "Bearer dune-token" }),
  })
}
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}
function executeRoute(): FetchStub {
  return { match: (url) => url.includes("/execute"), respond: () => ({ json: {}, status: 200 }) }
}
function resultsRoute(): FetchStub {
  return { match: (url) => url.includes("/results"), respond: () => ({ json: { result: { rows: [] } }, status: 200 }) }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => { fetchMock?.restore(); fetchMock = null; delete process.env.DUNE_OWNERSHIP_INCREMENTAL })
beforeEach(() => {
  state.afterCbs.length = 0
  process.env.INGEST_SECRET_TOKEN = "dune-token"
  process.env.DUNE_PROXY_URL = PROXY
  process.env.DUNE_PROXY_SECRET = "dune-secret"
  process.env.DUNE_OWNERSHIP_QUERY_ID = "424242"
  process.env.DUNE_OWNERSHIP_INCREMENTAL = "1"
})

function executeCalls() {
  return (fetchMock?.calls ?? []).filter((c: any) => String(c.url ?? c).includes("/execute"))
}

describe("incremental mode: an empty target list SKIPS, it does not full-walk", () => {
  it("no targets -> no /execute at all, and a terminal row saying why", async () => {
    const spy = install({ "rpc:get_ownership_backfill_targets": { data: [], error: null } })
    fetchMock = installFetchMock([executeRoute(), resultsRoute()])

    await GET(req())
    await runDeferred()

    // The load-bearing assertion: NOT "we sent the right body" but "we sent
    // nothing". A parameterless /execute IS the 876,600-datapoint full walk.
    expect(executeCalls()).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_extra.skipped).toBe("no_incremental_targets")
    // Nothing was owed and nothing was spent, so this is a success, not a failure.
    expect(log.p_ok).toBe(true)
    expect(log.p_rows_written).toBe(0)
  })

  it("the targets RPC THROWING is also a skip, not a full walk", async () => {
    // This is the nastier half. The catch swallows the error into refreshNote and
    // falls through, so before the fix a transient DB blip bought the whole month.
    const spy = install({
      "rpc:get_ownership_backfill_targets": { data: null, error: { message: "boom" } },
    })
    fetchMock = installFetchMock([executeRoute(), resultsRoute()])

    await GET(req())
    await runDeferred()

    expect(executeCalls()).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls).p_extra.skipped).toBe("no_incremental_targets")
  })

  it("exactly ONE terminal row is written on the skip path", async () => {
    // The early return sits inside the after() callback's try, and the route's
    // own comment records that `finally` does not run reliably here. If a later
    // edit ever adds one, this catches the double-log.
    const spy = install({ "rpc:get_ownership_backfill_targets": { data: [], error: null } })
    fetchMock = installFetchMock([executeRoute(), resultsRoute()])

    await GET(req())
    await runDeferred()

    const terminal = spy.rpcCalls.filter(
      (c) => c.name === "log_pipeline_run" && (c.args as any)?.p_rows_found !== undefined
    )
    expect(terminal).toHaveLength(1)
  })

  it("WITH targets it still executes, bounded by set_ids — the no-change control", async () => {
    // Over-skipping would silently retire the lane, which looks like nothing at
    // all. This is the direction no counter would notice.
    const spy = install({
      "rpc:get_ownership_backfill_targets": { data: [{ set_id_onchain: 7 }, { set_id_onchain: 9 }], error: null },
    })
    fetchMock = installFetchMock([executeRoute(), resultsRoute()])

    await GET(req())
    await runDeferred()

    expect(executeCalls().length).toBeGreaterThan(0)
    expect(terminalLog(spy.rpcCalls)?.p_extra?.skipped).not.toBe("no_incremental_targets")
  })

  it("passes the cycle allowance into the targets RPC as p_max_datapoints", async () => {
    // Item 2. Unbounded, the cheapest-first walk eventually reaches a set larger
    // than a whole cycle (Base Set S4 alone is ~91,979,724 datapoints), truncates,
    // restarts at offset 0 next run, and burns the reservation forever.
    const spy = install({
      "rpc:get_ownership_backfill_targets": { data: [{ set_id_onchain: 7 }], error: null },
    })
    fetchMock = installFetchMock([executeRoute(), resultsRoute()])

    await GET(req())
    await runDeferred()

    const call = spy.rpcCalls.find((c) => c.name === "get_ownership_backfill_targets")
    expect(call).toBeTruthy()
    expect((call!.args as any).p_max_datapoints).toBe(900000)
  })
})
