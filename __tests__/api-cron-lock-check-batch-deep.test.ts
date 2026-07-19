import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/cron/lock-check-batch — the on-chain lock-check writer.
// Pins the batch semantics that keep the "locked" flag honest:
//   - per-slug candidate reads are grouped by (wallet, collection) into ONE
//     Cadence call, decoded, and applied via apply_lock_check_batch;
//   - unsupported collections (no lock primitive) are counted, never fabricated;
//   - a Cadence group failure logs ok=false with the cadence error, no write;
//   - all-slug batch-read failure short-circuits to a batch_read ok=false row;
//   - no-candidates logs a clean ok=true "no candidates" row;
//   - a fatal throw inside runBatch still writes the fatal pipeline_runs row;
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

process.env.INGEST_SECRET_TOKEN = "lock-token"

const { POST } = await import("@/app/api/cron/lock-check-batch/route")

const TS_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")

// Flow REST /scripts returns the JSON-CDC value base64-encoded in the body text.
// The route decodes: JSON.parse(atob(body)).value -> [{key:{value}, value:{value}}]
function lockScriptResult(map: Record<string, boolean>): string {
  return b64({
    type: "Dictionary",
    value: Object.entries(map).map(([k, v]) => ({
      key: { type: "UInt64", value: k },
      value: { type: "Bool", value: v },
    })),
  })
}

// A fetch stub returning the raw base64 body as .text() (jsonRoute can't — it
// JSON.stringifies). `results` is consumed one-per-call (sequence-aware).
function flowRest(results: Array<{ status?: number; body?: string }>): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("rest-mainnet.onflow.org"),
    respond: () => {
      const r = results[Math.min(call, results.length - 1)]
      call++
      return { status: r.status ?? 200, text: r.body ?? "" }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:get_lock_check_batch": { data: [], error: null },
    "rpc:apply_lock_check_batch": { data: { updated: 0 }, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/cron/lock-check-batch", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer lock-token" }),
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

function cand(slug: string, wallet: string, moment: string, collectionId: string) {
  return {
    out_wallet_address: wallet,
    out_moment_id: moment,
    out_collection_id: collectionId,
    out_collection_slug: slug,
  }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
})

describe("lock-check-batch — happy path", () => {
  it("groups a wallet's TopShot candidates into one Cadence call and applies the decoded locks", async () => {
    // get_lock_check_batch is called per-slug for the two supported collections
    // (nba_top_shot, then disney_pinnacle); only the nba_top_shot call returns rows.
    const spy = install({
      "rpc:get_lock_check_batch": [
        { data: [cand("nba_top_shot", "0xw1", "111", TS_UUID), cand("nba_top_shot", "0xw1", "222", TS_UUID)], error: null },
        { data: [], error: null }, // disney_pinnacle
      ],
      "rpc:apply_lock_check_batch": { data: { updated: 2 }, error: null },
    })
    fetchMock = installFetchMock([flowRest([{ body: lockScriptResult({ "111": true, "222": false }) }])])

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    // Exactly ONE Cadence call for the single (wallet, collection) group.
    expect(fetchMock.calls).toHaveLength(1)

    // apply_lock_check_batch received both decoded rows with the on-chain flags.
    const apply = spy.rpcCalls.find((c) => c.name === "apply_lock_check_batch")?.args as any
    const results = apply.p_results as Array<{ moment_id: string; is_locked: boolean }>
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.moment_id === "111")?.is_locked).toBe(true)
    expect(results.find((r) => r.moment_id === "222")?.is_locked).toBe(false)

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "lock-check-batch", p_ok: true, p_rows_found: 2, p_rows_written: 2 })
    expect(log.p_extra).toMatchObject({ wallets_processed: 1, wallets_grouped: 1 })
  })

  it("counts unsupported-collection candidates without fabricating a lock result", async () => {
    // Defensive-bucket test: the route only queries the two supported slugs, but
    // it groups results by each candidate's OWN slug and buckets any without a
    // Cadence script. Here the 2nd (disney_pinnacle) call returns a candidate
    // whose slug has no lock primitive (nfl_all_day) -> unsupported bucket, 0 rows.
    const spy = install({
      "rpc:get_lock_check_batch": [
        { data: [cand("nba_top_shot", "0xw1", "111", TS_UUID)], error: null },
        { data: [cand("nfl_all_day", "0xw2", "999", "dee28451-5d62-409e-a1ad-a83f763ac070")], error: null },
      ],
      "rpc:apply_lock_check_batch": { data: { updated: 1 }, error: null },
    })
    fetchMock = installFetchMock([flowRest([{ body: lockScriptResult({ "111": true }) }])])

    await POST(req())
    await runDeferred()

    // Only the TopShot wallet hit the chain; AllDay never did.
    expect(fetchMock.calls).toHaveLength(1)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(1)
    expect(log.p_rows_skipped).toBe(1) // the unsupported AllDay row
    expect(log.p_extra.unsupported_collections).toMatchObject({ nfl_all_day: 1 })
  })
})

describe("lock-check-batch — degradation + honesty", () => {
  it("a Cadence group failure logs ok=false with the cadence error and writes nothing", async () => {
    const spy = install({
      "rpc:get_lock_check_batch": [
        { data: [cand("nba_top_shot", "0xw1", "111", TS_UUID)], error: null },
        { data: [], error: null }, // disney_pinnacle
      ],
    })
    fetchMock = installFetchMock([flowRest([{ status: 503, body: "upstream unavailable" }])])

    await POST(req())
    await runDeferred()

    // No results -> apply_lock_check_batch never called.
    expect(spy.rpcCalls.some((c) => c.name === "apply_lock_check_batch")).toBe(false)
    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("cadence:")
    expect(String(log.p_error)).toContain("503")
  })

  it("all-slug batch-read failure short-circuits to a batch_read ok=false row", async () => {
    const spy = install({
      "rpc:get_lock_check_batch": { data: null, error: { message: "statement timeout" } },
    })
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(log.p_extra.stage).toBe("batch_read")
    expect(String(log.p_error)).toContain("statement timeout")
  })

  it("no candidates logs a clean ok=true 'no candidates' row", async () => {
    const spy = install({}) // all slugs default to empty
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect(log.p_extra.note).toBe("no candidates")
  })

  it("a fatal throw inside runBatch still writes the fatal pipeline_runs row", async () => {
    // Non-iterable data makes `for (const r of data)` throw before any log.
    const spy = install({
      "rpc:get_lock_check_batch": { data: 42 as never, error: null },
    })
    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("batch crashed:")
    expect(log.p_extra.fatal).toBe(true)
  })

  it("401s without the token and registers no deferred work", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/cron/lock-check-batch", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
