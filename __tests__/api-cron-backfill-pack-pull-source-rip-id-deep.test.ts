import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of /api/cron/backfill-pack-pull-source-rip-id. The base test stubs
// after() to a no-op, so the entire deferred body — the backfill RPC, the
// result accounting (rows_written = exact + inferred, rows_skipped = no_match),
// the RPC-error branch, and the pipeline_runs logging — was never exercised.
// Here after() is CAPTURED and run, and the RPC seam is instrumented, so we pin
// what the route actually WRITES to pipeline_runs on each outcome.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => (state.sb as Record<PropertyKey, unknown>)[p] }),
  supabase: new Proxy({}, { get: (_t, p) => (state.sb as Record<PropertyKey, unknown>)[p] }),
}))

const { POST, GET } = await import("@/app/api/cron/backfill-pack-pull-source-rip-id/route")

const url = "https://t/api/cron/backfill-pack-pull-source-rip-id"
const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
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
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  state.afterCbs.length = 0
})
afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("backfill-pack-pull-source-rip-id — deferred body", () => {
  it("logs the backfill result: rows_written = exact + inferred, rows_skipped = no_match, ok", async () => {
    const spy = install({
      "rpc:backfill_pack_pull_source_rip_id": {
        data: { examined: 10, exact_match: 8, inferred: 1, no_match: 1 },
        error: null,
      },
    })

    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_pipeline: "pack-pull-source-rip-id-backfill",
      p_rows_found: 10,
      p_rows_written: 9, // exact 8 + inferred 1
      p_rows_skipped: 1, // no_match
      p_ok: true,
      p_error: null,
      p_collection_slug: "nba_top_shot",
    })
    expect(log?.p_extra).toMatchObject({ limit: 1000, examined: 10, exact_match: 8, inferred: 1, no_match: 1 })
  })

  it("logs ok=false with the message when the backfill RPC returns an error", async () => {
    const spy = install({
      "rpc:backfill_pack_pull_source_rip_id": { data: null, error: { message: "deadlock detected" } },
    })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: false,
      p_error: "deadlock detected",
      // No result -> every count defaults to 0.
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
    })
  })

  it("logs ok=false when the RPC call THROWS (defensive catch)", async () => {
    const spy = install({})
    // Override rpc so the backfill call throws, but log_pipeline_run still resolves.
    const base = (spy.fixture as any).rpc.bind(spy.fixture)
    ;(spy.fixture as any).rpc = async (name: string, args?: Record<string, unknown>) => {
      if (name === "backfill_pack_pull_source_rip_id") throw new Error("connection reset")
      return base(name, args)
    }

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_error: "connection reset" })
  })

  it("clamps the limit param into [1, 5000] and reflects it in body + the logged extra", async () => {
    // Over-cap.
    let spy = install({
      "rpc:backfill_pack_pull_source_rip_id": { data: { examined: 0, exact_match: 0, inferred: 0, no_match: 0 }, error: null },
    })
    let res = await POST(makeReq({ url: url + "?limit=99999", auth: "Bearer test-ingest-secret" }))
    expect((await res.json()).limit).toBe(5000)
    await runDeferred()
    expect((logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>).limit).toBe(5000)

    // Under-floor (0 -> 1).
    spy = install({
      "rpc:backfill_pack_pull_source_rip_id": { data: { examined: 0, exact_match: 0, inferred: 0, no_match: 0 }, error: null },
    })
    res = await POST(makeReq({ url: url + "?limit=0", auth: "Bearer test-ingest-secret" }))
    expect((await res.json()).limit).toBe(1)
    await runDeferred()
    expect((logRun(spy.rpcCalls)?.p_extra as Record<string, unknown>).limit).toBe(1)
  })

  it("swallows a log_pipeline_run failure — the best-effort logging never rejects the deferred body", async () => {
    const spy = install({})
    ;(spy.fixture as any).rpc = async (name: string) => {
      if (name === "backfill_pack_pull_source_rip_id") {
        return { data: { examined: 3, exact_match: 3, inferred: 0, no_match: 0 }, error: null }
      }
      if (name === "log_pipeline_run") throw new Error("log table locked")
      return { data: null, error: null }
    }

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    // The deferred body must resolve despite the logging throw (no unhandled reject).
    await expect(runDeferred()).resolves.toBeUndefined()
  })

  it("GET alias runs the same deferred body", async () => {
    const spy = install({
      "rpc:backfill_pack_pull_source_rip_id": { data: { examined: 2, exact_match: 2, inferred: 0, no_match: 0 }, error: null },
    })
    await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    await runDeferred()
    expect(logRun(spy.rpcCalls)).toMatchObject({ p_rows_written: 2 })
  })
})
