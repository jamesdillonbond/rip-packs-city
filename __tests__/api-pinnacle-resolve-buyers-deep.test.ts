import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/pinnacle/resolve-buyers — the buyer/seller executor.
// Claims a batch via claim_pinnacle_resolver_batch, fetches each tx's Cadence
// script from Flow REST, regex-extracts buyer/seller, and calls
// finish_pinnacle_resolver_item per resolved/pre_spork row. Synchronous. Pinned:
//   - the 4-way outcome accounting: resolved (regex hit, addresses lowercased),
//     pre_spork (404), regex_miss (200 but no addresses), fetch_error (non-ok);
//   - finish is called only for resolved + pre_spork, with the exact
//     p_resolution_status; a finish-RPC error downgrades a resolved row into
//     fetch_errors (never double-counts);
//   - log_pipeline_run carries rows_found/written(resolved+preSpork)/skipped
//     (fetch+regex) + the extra breakdown + function_version;
//   - no_work short-circuits before any fetch/log; a claim error 500s; 401 guard.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "rb-ingest"
process.env.CRON_SECRET = "rb-cron"
const { POST } = await import("@/app/api/pinnacle/resolve-buyers/route")

// A tx-fetch stub matching a specific tx_hash in the Flow REST URL.
function txStub(
  hash: string,
  opts: { status?: number; script?: string },
): FetchStub {
  return {
    match: (url) => url.includes(`/v1/transactions/${hash}`),
    respond: () =>
      opts.status && opts.status !== 200
        ? { status: opts.status, ok: false, text: "err" }
        : { json: { script: opts.script != null ? Buffer.from(opts.script, "utf8").toString("base64") : undefined } },
  }
}

function scriptWith(buyer: string, seller: string): string {
  return `transaction {\n  // args\n  buyerAddress: Address = ${buyer}\n  sellerAddress: Address = ${seller}\n}`
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>, qs = ""): NextRequest {
  return new NextRequest(`https://t/api/pinnacle/resolve-buyers${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer rb-ingest" }),
  })
}

function logRun(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}
function finishCalls(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "finish_pinnacle_resolver_item").map((c) => c.args)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "rb-ingest"
  process.env.CRON_SECRET = "rb-cron"
})

describe("pinnacle-resolve-buyers — auth + control", () => {
  it("401s with no credential and does no work", async () => {
    const spy = install({})
    const res = await POST(req({}))
    expect(res.status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)
  })

  it("no_work short-circuits before any fetch or log", async () => {
    fetchMock = installFetchMock([])
    const spy = install({ "rpc:claim_pinnacle_resolver_batch": { data: [], error: null } })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ status: "no_work" })
    expect(fetchMock.calls).toHaveLength(0)
    expect(spy.rpcCalls.some((c) => c.name === "log_pipeline_run")).toBe(false)
  })

  it("a claim error 500s claim_failed", async () => {
    const spy = install({ "rpc:claim_pinnacle_resolver_batch": { data: null, error: { message: "claim boom" } } })
    const res = await POST(req(undefined, "?token=rb-cron"))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ status: "error", reason: "claim_failed", error: "claim boom" })
    expect(spy.rpcCalls.some((c) => c.name === "log_pipeline_run")).toBe(false)
  })
})

describe("pinnacle-resolve-buyers — outcome accounting", () => {
  it("resolves, pre-sporks, regex-misses, and fetch-errors are counted + finished exactly", async () => {
    const rows = [
      { id: "r-resolved", tx_hash: "a".repeat(64), sold_at: "2026-07-01T00:00:00Z", attempts: 0 },
      { id: "r-prespork", tx_hash: "b".repeat(64), sold_at: "2026-07-01T00:00:00Z", attempts: 0 },
      { id: "r-regex", tx_hash: "c".repeat(64), sold_at: "2026-07-01T00:00:00Z", attempts: 0 },
      { id: "r-fetcherr", tx_hash: "d".repeat(64), sold_at: "2026-07-01T00:00:00Z", attempts: 0 },
    ]
    fetchMock = installFetchMock([
      txStub("a".repeat(64), { script: scriptWith("0xABCDEF0011223344", "0xFED0000000000000") }),
      txStub("b".repeat(64), { status: 404 }),
      txStub("c".repeat(64), { script: "transaction { /* no addresses here */ }" }),
      txStub("d".repeat(64), { status: 500 }),
    ])
    const spy = install({
      "rpc:claim_pinnacle_resolver_batch": { data: rows, error: null },
      "rpc:finish_pinnacle_resolver_item": { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({
      status: "ok",
      resolved: 1,
      pre_spork: 1,
      errors: 2, // fetch_error + regex_miss
      total_claimed: 4,
    })

    const finishes = finishCalls(spy.rpcCalls)
    expect(finishes).toHaveLength(2)
    // resolved row: addresses lowercased.
    expect(finishes.find((a) => a?.p_id === "r-resolved")).toMatchObject({
      p_buyer: "0xabcdef0011223344",
      p_seller: "0xfed0000000000000",
      p_resolution_status: "resolved",
    })
    // pre_spork row: null buyer/seller, pre_spork status.
    expect(finishes.find((a) => a?.p_id === "r-prespork")).toMatchObject({
      p_buyer: null,
      p_seller: null,
      p_resolution_status: "pre_spork",
    })

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_rows_found: 4,
      p_rows_written: 2, // resolved + pre_spork
      p_rows_skipped: 2, // fetch_error + regex_miss
      p_ok: true,
      p_collection_slug: "disney_pinnacle",
    })
    expect(log?.p_extra).toMatchObject({
      total_claimed: 4,
      resolved: 1,
      pre_spork: 1,
      fetch_errors: 1,
      regex_misses: 1,
      function_version: 1,
    })
  })

  it("a finish-RPC error downgrades a resolved row into fetch_errors (never double-counts)", async () => {
    const rows = [{ id: "r1", tx_hash: "e".repeat(64), sold_at: "2026-07-01T00:00:00Z", attempts: 0 }]
    fetchMock = installFetchMock([
      txStub("e".repeat(64), { script: scriptWith("0xaaaa000000000000", "0xbbbb000000000000") }),
    ])
    const spy = install({
      "rpc:claim_pinnacle_resolver_batch": { data: rows, error: null },
      "rpc:finish_pinnacle_resolver_item": { data: null, error: { message: "finish boom" } },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ status: "ok", resolved: 0, errors: 1, total_claimed: 1 })
    const log = logRun(spy.rpcCalls)
    expect(log?.p_extra).toMatchObject({ resolved: 0, fetch_errors: 1 })
  })
})
