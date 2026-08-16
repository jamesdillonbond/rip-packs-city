import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST/GET /api/cron/ownership-onchain-walk — Pipeline B, the
// on-chain VERIFICATION walk for the TopShot ownership index. Work runs in
// after(): for each stale-verified wallet it reads the wallet's held moment IDs
// via fcl (mocked) and re-stamps every still-held Dune-attributed row as
// source='onchain_walk'; rows no longer held are counted `vanished` (untouched).
// Pinned:
//   - happy walk: exact topshot_ownership upsert row (source onchain_walk, fresh
//     observed_at, onConflict nft_id), confirmed vs vanished split, and the
//     log_pipeline_run accounting (rows_found=confirmed+vanished, written=confirmed,
//     skipped=vanished);
//   - an fcl error on a wallet -> wallet_errors (not walked, no select);
//   - a per-wallet select error -> wallet_errors (walked, no confirm);
//   - an upsert error -> ok=false 'upsert:' log;
//   - the stale-wallets RPC error -> ok=false 'stale-wallets:' log;
//   - the 401 auth guard defers nothing.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  heldByWallet: {} as Record<string, string[] | "throw">,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async ({ args }: { args: (arg: (v: unknown, t: unknown) => unknown) => unknown[] }) => {
      // The route's args builder is (arg)=>[arg(wallet, t.Address)] — capture the wallet.
      const captured = args((v: unknown) => v)
      const wallet = String(captured[0])
      const held = state.heldByWallet[wallet]
      if (held === "throw") throw new Error("fcl query failed")
      return held ?? []
    },
  },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "walk-ingest"
process.env.CRON_SECRET = "walk-cron"
const { POST, GET } = await import("@/app/api/cron/ownership-onchain-walk/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/cron/ownership-onchain-walk", {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer walk-ingest" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function logRun(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "walk-ingest"
  process.env.CRON_SECRET = "walk-cron"
  state.afterCbs.length = 0
  state.heldByWallet = {}
})

describe("ownership-onchain-walk — auth", () => {
  it("401s with a wrong token and defers nothing", async () => {
    install({})
    const res = await POST(req({ authorization: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})

describe("ownership-onchain-walk — verification walk", () => {
  it("re-stamps still-held rows (confirmed), counts vanished, upserts onConflict nft_id, logs the split", async () => {
    const W = "0xwallet0000000001"
    state.heldByWallet = { [W]: ["100", "200"] } // holds 100 & 200, not 300
    const spy = install({
      "rpc:get_stale_ownership_wallets": { data: [{ owner_address: W }], error: null },
      topshot_ownership: [
        // per-wallet select
        {
          data: [
            { nft_id: "100", edition_external_id: "3:45", serial_number: 12 },
            { nft_id: "300", edition_external_id: "9:90", serial_number: 7 }, // no longer held -> vanished
          ],
          error: null,
        },
        // upsert
        { data: null, error: null },
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true, accepted: true, pipeline: "ownership-onchain-walk" })
    await runDeferred()

    const upserts = (spy.writes.topshot_ownership ?? []).filter((w) => w.method === "upsert")
    const rows = upserts.flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      nft_id: "100",
      edition_external_id: "3:45",
      owner_address: W,
      serial_number: 12,
      source: "onchain_walk",
    })
    expect(typeof rows[0].observed_at).toBe("string")

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_pipeline: "ownership-onchain-walk",
      p_rows_found: 2, // confirmed + vanished
      p_rows_written: 1, // confirmed
      p_rows_skipped: 1, // vanished
      p_ok: true,
    })
    expect(log?.p_extra).toMatchObject({ wallets_walked: 1, confirmed: 1, vanished: 1, wallet_errors: 0, budget_hit: false })
  })

  it("an fcl error on the wallet counts wallet_errors and skips its select", async () => {
    const W = "0xwallet0000000002"
    state.heldByWallet = { [W]: "throw" }
    const spy = install({
      "rpc:get_stale_ownership_wallets": { data: [{ owner_address: W }], error: null },
      topshot_ownership: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.topshot_ownership ?? []).toHaveLength(0)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect(log?.p_extra).toMatchObject({ wallets_walked: 0, wallet_errors: 1, confirmed: 0 })
  })

  it("a per-wallet select error counts wallet_errors (walked, but no confirm)", async () => {
    const W = "0xwallet0000000003"
    state.heldByWallet = { [W]: ["500"] }
    const spy = install({
      "rpc:get_stale_ownership_wallets": { data: [{ owner_address: W }], error: null },
      topshot_ownership: { data: null, error: { message: "select denied" } },
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_extra).toMatchObject({ wallets_walked: 1, wallet_errors: 1, confirmed: 0, vanished: 0 })
  })

  it("an upsert error flips ok=false with an 'upsert:' error", async () => {
    const W = "0xwallet0000000004"
    state.heldByWallet = { [W]: ["600"] }
    const spy = install({
      "rpc:get_stale_ownership_wallets": { data: [{ owner_address: W }], error: null },
      topshot_ownership: [
        { data: [{ nft_id: "600", edition_external_id: "1:1", serial_number: 1 }], error: null }, // select
        { data: null, error: { message: "conflict target missing" } }, // upsert
      ],
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("upsert:")
  })

  it("a stale-wallets RPC error flips ok=false with a 'stale-wallets:' error", async () => {
    const spy = install({
      "rpc:get_stale_ownership_wallets": { data: null, error: { message: "rpc down" } },
    })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("stale-wallets:")
  })

  // Regression pins for the 2026-08-15/16 outage: two consecutive daily ticks died
  // at ~72s with "Timed out acquiring connection from connection pool" on the
  // get_stale_ownership_wallets call, walking ZERO wallets and never touching the
  // route's own 720s budget. The gating read now goes through rpcWithRetry with a
  // batch-sized backoff (not the page-render default).
  //
  // Both directions matter. Retrying too EAGERLY is its own defect — a genuine
  // logic error must still fail fast instead of stalling a cron for five minutes —
  // so the non-transient case is pinned right alongside the transient one.
  it("retries a pool-acquire timeout on the gating read and recovers (wallets still get walked)", async () => {
    vi.useFakeTimers()
    try {
      const W = "0xwallet0000000002"
      state.heldByWallet = { [W]: ["100"] }
      const spy = install({
        "rpc:get_stale_ownership_wallets": [
          // Attempt 1 — the exact shape observed in prod on 08-15 and 08-16.
          {
            data: null,
            error: { message: "Timed out acquiring connection from connection pool." },
          },
          // Attempt 2 — the pool frees up.
          { data: [{ owner_address: W }], error: null },
        ],
        topshot_ownership: [
          { data: [{ nft_id: "100", edition_external_id: "3:45", serial_number: 12 }], error: null },
          { data: null, error: null },
        ],
      })

      await POST(req())
      const drained = runDeferred()
      // Drive the 20s backoff without sleeping for real.
      await vi.runAllTimersAsync()
      await drained

      const staleCalls = spy.rpcCalls.filter((c) => c.name === "get_stale_ownership_wallets")
      expect(staleCalls).toHaveLength(2) // retried, not fatal on the first error

      const log = logRun(spy.rpcCalls)
      expect(log?.p_ok).toBe(true)
      // The whole point: the run recovered and did real work rather than logging
      // wallets_walked: 0 like the two failed prod ticks.
      expect(Number((log?.p_extra as Record<string, unknown>)?.wallets_walked)).toBe(1)
      expect(String(log?.p_error ?? "")).not.toContain("stale-wallets:")
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT retry a non-transient gating-read error — it still fails fast", async () => {
    const spy = install({
      "rpc:get_stale_ownership_wallets": [
        { data: null, error: { message: "relation does not exist" } },
        { data: [{ owner_address: "0xshould_never_be_reached" }], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const staleCalls = spy.rpcCalls.filter((c) => c.name === "get_stale_ownership_wallets")
    expect(staleCalls).toHaveLength(1)
    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("stale-wallets:")
  })

  it("GET alias reaches the same 202 accept when authed", async () => {
    install({ "rpc:get_stale_ownership_wallets": { data: [], error: null } })
    const res = await GET(req({ authorization: "Bearer walk-cron" }))
    expect(res.status).toBe(202)
    await runDeferred()
  })
})
