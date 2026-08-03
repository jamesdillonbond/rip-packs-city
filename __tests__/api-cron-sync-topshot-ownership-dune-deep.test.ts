import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of GET/POST /api/cron/sync-topshot-ownership-dune — the Dune
// ownership-index walker. Pins:
//   - INERT skip when unconfigured logs skipped:'dune_not_configured' (no walk);
//   - a configured ?norefresh=1 walk maps rows (deriving edition_external_id incl.
//     the "::subId" parallel suffix) and upserts topshot_ownership by nft_id;
//   - unmappable rows are skipped, not fatal;
//   - an execute-HTTP failure falls through to the cached results (never empty);
//   - a proxy results HTTP error flips ok=false;
//   - an upsert error flips ok=false;
//   - the auth guard.

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

const { GET } = await import("@/app/api/cron/sync-topshot-ownership-dune/route")

const PROXY = "https://dune-proxy.example"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    topshot_ownership: { data: null, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(query = ""): NextRequest {
  return new NextRequest(`https://t/api/cron/sync-topshot-ownership-dune${query}`, {
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

function resultsRoute(json: unknown, opts: { status?: number } = {}): FetchStub {
  return {
    match: (url) => url.includes("/results"),
    respond: () => ({ json, status: opts.status }),
  }
}
function executeRoute(opts: { status?: number; json?: unknown } = {}): FetchStub {
  return {
    match: (url) => url.includes("/execute"),
    respond: () => ({ json: opts.json ?? {}, status: opts.status }),
  }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
  process.env.INGEST_SECRET_TOKEN = "dune-token"
  delete process.env.DUNE_PROXY_URL
  delete process.env.DUNE_PROXY_SECRET
  delete process.env.DUNE_OWNERSHIP_QUERY_ID
  delete process.env.DUNE_OWNERSHIP_INCREMENTAL
})

function configure() {
  process.env.DUNE_PROXY_URL = PROXY
  process.env.DUNE_PROXY_SECRET = "dune-secret"
  process.env.DUNE_OWNERSHIP_QUERY_ID = "424242"
}

describe("sync-topshot-ownership-dune — inert + walk", () => {
  it("logs an honest 'dune_not_configured' skip and does no walk when unconfigured", async () => {
    const spy = install({}) // env intentionally unset
    const res = await GET(req())
    expect(res.status).toBe(202)
    expect((await res.json()).skipped).toBe("dune_not_configured")
    // Skip is logged synchronously, before any after() work.
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_extra).toMatchObject({ skipped: "dune_not_configured" })
    expect(state.afterCbs).toHaveLength(0)
  })

  it("norefresh walk maps rows (with ::subId parallel suffix) and upserts by nft_id", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      resultsRoute({
        result: {
          rows: [
            { nft_id: "1001", set_id: 3, play_id: 45, sub_edition_id: 0, owner_address: "0xA", serial_number: 7 },
            { nft_id: "1002", set_id: 3, play_id: 45, sub_edition_id: 19, owner_address: "0xB", serial_number: 2 },
          ],
        },
        next_offset: null,
      }),
    ])

    await GET(req("?norefresh=1"))
    await runDeferred()

    // Only /results hit (refresh skipped).
    expect(fetchMock.calls.every((c) => c.url.includes("/results"))).toBe(true)

    const upserts = (spy.writes.topshot_ownership ?? []).flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const byNft = Object.fromEntries(upserts.map((r) => [r.nft_id, r]))
    // Base pair -> "set:play"; parallel -> "set:play::sub".
    expect(byNft["1001"]).toMatchObject({ edition_external_id: "3:45", owner_address: "0xA", source: "dune" })
    expect(byNft["1002"]).toMatchObject({ edition_external_id: "3:45::19", owner_address: "0xB" })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 2, p_rows_skipped: 0 })
    expect(log.p_extra).toMatchObject({ exhausted: true, query_id: "424242" })
  })

  it("skips rows missing key fields without failing the run", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      resultsRoute({
        result: {
          rows: [
            { nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }, // ok
            { nft_id: "1002", set_id: 3, play_id: 45 }, // no owner -> skipped
          ],
        },
        next_offset: null,
      }),
    ])

    await GET(req("?norefresh=1"))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 1, p_rows_skipped: 1 })
  })
})

describe("sync-topshot-ownership-dune — refresh fallthrough + failures", () => {
  it("an execute HTTP failure still walks the cached results but reports ok=false + stale_cache", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute({ status: 404 }), // un-upgraded worker
      resultsRoute({ result: { rows: [{ nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }] }, next_offset: null }),
    ])

    await GET(req()) // refresh NOT skipped -> hits /execute first
    await runDeferred()

    expect(fetchMock.calls.some((c) => c.url.includes("/execute"))).toBe(true)
    const log = terminalLog(spy.rpcCalls)
    // The fallthrough is deliberate — the table is never emptied...
    expect(log.p_rows_written).toBe(1) // cached results still landed
    // ...but the run re-ingested last execution's rows and accomplished nothing,
    // so it must not report success. This pipeline has no cadence-watchlist row,
    // making ok=false its only alarm.
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("stale cache")
    expect(String(log.p_extra.refresh_note)).toContain("execute HTTP 404")
    expect(log.p_extra.refreshed).toBe(false)
    expect(log.p_extra.stale_cache).toBe(true)
    expect(log.p_extra.refresh_http_status).toBe(404)
  })

  it("credit exhaustion (execute HTTP 402) is recorded distinguishably from a missing worker route", async () => {
    // The live 2026-08-03 failure mode: the dune-proxy worker forwards fine, Dune
    // refuses to execute because the monthly credits are spent. Without this the
    // run logged ok=true while serving week-old cache.
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute({ status: 402 }),
      resultsRoute({ result: { rows: [{ nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }] }, next_offset: null }),
    ])

    await GET(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.stale_cache).toBe(true)
    expect(log.p_extra.refresh_http_status).toBe(402) // 402 = credits, not 404 = worker
    expect(String(log.p_extra.refresh_note)).toContain("execute HTTP 402")
  })

  it("a successful refresh reports ok=true with stale_cache=false", async () => {
    // The positive control: without this, a change that hardcoded ok=false on the
    // refresh path would still pass every assertion above.
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      executeRoute({ json: { execution_id: "exec-1" } }),
      {
        match: (url) => url.includes("/status"),
        respond: () => ({ json: { state: "QUERY_STATE_COMPLETED" } }),
      },
      resultsRoute({ result: { rows: [{ nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }] }, next_offset: null }),
    ])

    await GET(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.refreshed).toBe(true)
    expect(log.p_extra.stale_cache).toBe(false)
    expect(log.p_extra.refresh_http_status).toBeNull()
  })

  it("norefresh=1 is not treated as a stale-cache failure (no refresh was attempted)", async () => {
    // Guards the operator's deliberate cache-only walk from becoming a false alarm.
    configure()
    const spy = install({})
    fetchMock = installFetchMock([
      resultsRoute({ result: { rows: [{ nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }] }, next_offset: null }),
    ])

    await GET(req("?norefresh=1"))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.stale_cache).toBe(false)
  })

  it("a proxy /results HTTP error flips ok=false with the offset in the message", async () => {
    configure()
    const spy = install({})
    fetchMock = installFetchMock([resultsRoute({}, { status: 502 })])

    await GET(req("?norefresh=1"))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("dune proxy HTTP 502")
  })

  it("an upsert error flips ok=false", async () => {
    configure()
    const spy = install({
      topshot_ownership: { data: null, error: { message: "conflict target invalid" } },
    })
    fetchMock = installFetchMock([
      resultsRoute({ result: { rows: [{ nft_id: "1001", set_id: 3, play_id: 45, owner_address: "0xA" }] }, next_offset: null }),
    ])

    await GET(req("?norefresh=1"))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("upsert: conflict target invalid")
  })

  it("401s without the bearer token", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/cron/sync-topshot-ownership-dune", { method: "GET" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
