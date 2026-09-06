import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Drive of GET/POST /api/cron/allday-lock-refresh-batch — the scheduled All Day
// lock-refresh orchestrator. Pins: the auth guard; the stalest-wallet fetch;
// one refreshAllDayWalletLocks call per candidate wallet; per-wallet failures
// are non-fatal and counted; the terminal pipeline_runs log shape.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  refresh: vi.fn(async (wallet: string) => ({
    wallet, total_cached: 10, unlocked_onchain: 8, marked_locked: 2, marked_unlocked: 0,
  })),
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/allday-lock", () => ({ refreshAllDayWalletLocks: state.refresh }))

const { GET, POST } = await import("@/app/api/cron/allday-lock-refresh-batch/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:get_allday_lock_refresh_wallets": {
      data: [{ wallet_address: "0xaaa" }, { wallet_address: "0xbbb" }],
      error: null,
    },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}
function req(auth = "Bearer tok"): NextRequest {
  return new NextRequest("https://t/api/cron/allday-lock-refresh-batch", {
    method: "POST",
    headers: new Headers(auth ? { authorization: auth } : {}),
  })
}
async function runDeferred() {
  const cbs = [...state.afterCbs]; state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as any
}

beforeEach(() => {
  state.afterCbs.length = 0
  state.refresh.mockClear()
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.CRON_SECRET = "cron"
})

describe("allday-lock-refresh-batch", () => {
  it("401s without a valid bearer, registering no after work", async () => {
    install({})
    const res = await POST(req(""))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("refreshes each stalest wallet and logs ok=true", async () => {
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()
    expect(state.refresh).toHaveBeenCalledTimes(2)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "allday-lock-refresh", p_ok: true, p_rows_found: 2 })
    expect(log.p_extra).toMatchObject({ wallets_processed: 2, lock_flips: 4 })
  })

  it("a per-wallet failure is non-fatal and counted — the batch stays ok=true because the other wallet refreshed", async () => {
    // 2026-09-06: one over-budget whale failed EVERY hourly tick from 09-05
    // 05:23Z while each tick still stamped 20K–33K rows; `ok = errors.length
    // === 0` published that as a 52.5% failure rate for 34 hours. ok now means
    // "the batch refreshed something"; the failure is still fully recorded.
    const spy = install({})
    state.refresh.mockImplementationOnce(async () => { throw new Error("whale over budget") })
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.wallets_processed).toBe(1)
    expect(log.p_extra.wallets_failed).toBe(1)
    expect(String(log.p_error)).toContain("whale over budget")
    expect(log.p_extra.errors[0]).toMatchObject({ wallet: expect.any(String), error: "whale over budget" })
  })

  it("EVERY wallet failing is still ok=false — a transport-class failure must not hide behind the per-wallet rule", async () => {
    const spy = install({})
    state.refresh
      .mockImplementationOnce(async () => { throw new Error("Flow 400 execution node") })
      .mockImplementationOnce(async () => { throw new Error("Flow 400 execution node") })
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.wallets_processed).toBe(0)
    expect(log.p_extra.wallets_failed).toBe(2)
    expect(String(log.p_error)).toContain("Flow 400")
  })

  it("a wallet-fetch error logs a wallet_fetch ok=false row", async () => {
    const spy = install({
      "rpc:get_allday_lock_refresh_wallets": { data: null, error: { message: "timeout" } },
    })
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.stage).toBe("wallet_fetch")
    expect(state.refresh).not.toHaveBeenCalled()
  })
})

// --- auth arms, the GET alias, the fatal catch, and the soft-deadline break ---

describe("allday-lock-refresh-batch — remaining branches", () => {
  it("401s with no bearer and with a wrong one", async () => {
    install({})
    expect((await POST(req(""))).status).toBe(401)
    expect((await POST(req("Bearer nope"))).status).toBe(401)
  })

  it("accepts the CRON_SECRET bearer as well as INGEST", async () => {
    install({})
    expect((await POST(req("Bearer cron"))).status).toBe(202)
    expect((await POST(req("Bearer tok"))).status).toBe(202)
  })

  it("401s when neither secret is configured (fail-closed)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    delete process.env.CRON_SECRET
    install({})
    expect((await POST(req("Bearer tok"))).status).toBe(401)
  })

  it("GET is an alias for POST and reaches the same 202 accept", async () => {
    install({})
    const res = await GET(req())
    expect(res.status).toBe(202)
    expect((await res.json())).toMatchObject({ accepted: true, pipeline: "allday-lock-refresh" })
  })

  it("logs a fatal row when the batch itself crashes", async () => {
    // the wallet-fetch RPC THROWS (not returns an error) -> runBatch throws ->
    // the outer catch must still leave a pipeline_runs paper trail
    const spy = install({})
    const fixture = spy.fixture as { rpc: (n: string, a?: unknown) => Promise<unknown> }
    const baseRpc = fixture.rpc.bind(fixture)
    fixture.rpc = async (name: string, args?: unknown) => {
      if (name === "get_allday_lock_refresh_wallets") throw new Error("pool exhausted")
      return baseRpc(name, args)
    }
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("batch crashed: pool exhausted")
    expect(log.p_extra).toMatchObject({ fatal: true })
  })

  it("stops at the soft deadline and reports the unprocessed wallets as skipped", async () => {
    const spy = install({
      "rpc:get_allday_lock_refresh_wallets": {
        data: [{ wallet_address: "0x1" }, { wallet_address: "0x2" }, { wallet_address: "0x3" }],
        error: null,
      },
    })
    // jump the clock past the soft deadline after the first wallet
    const realNow = Date.now
    let calls = 0
    // call 0 = first iteration's check (real, so wallet 1 processes);
    // every later call jumps past the soft deadline so iteration 2 breaks.
    Date.now = () => (calls++ >= 1 ? realNow() + 10 * 60_000 : realNow())
    try {
      await POST(req())
      await runDeferred()
    } finally {
      Date.now = realNow
    }
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_rows_found).toBe(3)
    expect(log.p_extra.wallets_processed).toBeLessThan(3)
    expect(log.p_rows_skipped).toBeGreaterThan(0)
  })

  it("logs a clean empty run when no wallets are stale", async () => {
    const spy = install({ "rpc:get_allday_lock_refresh_wallets": { data: [], error: null } })
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect(state.refresh).not.toHaveBeenCalled()
  })
})
