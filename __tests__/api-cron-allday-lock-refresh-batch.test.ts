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

  it("a per-wallet failure is non-fatal and counted", async () => {
    const spy = install({})
    state.refresh.mockImplementationOnce(async () => { throw new Error("whale over budget") })
    await POST(req())
    await runDeferred()
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.wallets_processed).toBe(1)
    expect(String(log.p_error)).toContain("whale over budget")
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
