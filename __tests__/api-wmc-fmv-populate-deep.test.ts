import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of GET/POST /api/wmc-fmv-populate — the wallet_moments_cache FMV +
// image denorm cron. Pins the contracts that keep /share tiles + portfolio FMV
// honest under contention:
//   - a single-collection tick runs the two per-collection denorm RPCs and logs
//     rows_updated/rows_imaged, and SKIPS the global drift refreshes;
//   - a full (all-collections) tick ALSO fires refresh_wmc_fmv_changed +
//     refresh_wmc_fmv_drift_active exactly once;
//   - an image-RPC failure is isolated (image_error in extra, FMV path stays ok);
//   - an FMV-RPC error flips ok=false with the error surfaced;
//   - the transient-error retry (statement timeout) recovers to a good row count;
//   - unknown-slug 400 and the auth guard.

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

// Module-const TOKEN is captured at import — set env before the dynamic import.
process.env.INGEST_SECRET_TOKEN = "wmc-token"

const { GET, POST } = await import("@/app/api/wmc-fmv-populate/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    "rpc:populate_wmc_fmv_from_snapshots": { data: 5, error: null },
    "rpc:populate_wmc_image": { data: 3, error: null },
    "rpc:refresh_wmc_fmv_changed": { data: null, error: null },
    "rpc:refresh_wmc_fmv_drift_active": { data: null, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(query = ""): NextRequest {
  return new NextRequest(`https://t/api/wmc-fmv-populate${query}`, {
    method: "GET",
    headers: new Headers({ authorization: "Bearer wmc-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function logsFor(pipeline: string, rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && (c.args as any)?.p_pipeline === pipeline)
}
function rpcNames(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.map((c) => c.name)
}

beforeEach(() => {
  state.afterCbs.length = 0
})

describe("wmc-fmv-populate — single-collection tick", () => {
  it("runs both denorm RPCs, logs the computed row counts, and SKIPS the global refreshes", async () => {
    const spy = install({})
    const res = await POST(req("?collection=nba-top-shot"))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ accepted: true, targets: ["nba-top-shot"], refresh: false })

    await runDeferred()

    // The two per-collection denorm RPCs fired.
    const names = rpcNames(spy.rpcCalls)
    expect(names).toContain("populate_wmc_fmv_from_snapshots")
    expect(names).toContain("populate_wmc_image")
    // Global drift refreshes are single-collection-suppressed.
    expect(names).not.toContain("refresh_wmc_fmv_changed")
    expect(names).not.toContain("refresh_wmc_fmv_drift_active")

    const log = logsFor("wmc-fmv-populate", spy.rpcCalls).at(-1)?.args as any
    expect(log).toMatchObject({
      p_ok: true,
      p_collection_slug: "nba-top-shot",
      // rows_found/written = rows_updated(5) + rows_imaged(3)
      p_rows_found: 8,
      p_rows_written: 8,
    })
    expect(log.p_extra).toMatchObject({ rows_updated: 5, rows_imaged: 3, image_error: null })
  })
})

describe("wmc-fmv-populate — full tick + degradation", () => {
  it("fires both global drift refreshes exactly once on an all-collections tick", async () => {
    const spy = install({})
    const res = await POST(req())
    expect((await res.json()).refresh).toBe(true)
    await runDeferred()

    const names = rpcNames(spy.rpcCalls)
    expect(names.filter((n) => n === "refresh_wmc_fmv_changed")).toHaveLength(1)
    expect(names.filter((n) => n === "refresh_wmc_fmv_drift_active")).toHaveLength(1)
    // Multiple published collections each logged their own per-collection row.
    const perCollLogs = logsFor("wmc-fmv-populate", spy.rpcCalls).filter(
      (c) => (c.args as any).p_collection_slug != null,
    )
    expect(perCollLogs.length).toBeGreaterThan(1)
  })

  it("isolates an image-RPC failure — image_error recorded, FMV path stays ok=true", async () => {
    const spy = install({
      "rpc:populate_wmc_image": { data: null, error: { message: "image tail timeout" } },
    })
    await POST(req("?collection=nba-top-shot"))
    await runDeferred()

    const log = logsFor("wmc-fmv-populate", spy.rpcCalls).at(-1)?.args as any
    expect(log.p_ok).toBe(true) // image failure does NOT fail the FMV path
    expect(log.p_extra).toMatchObject({ rows_updated: 5, rows_imaged: 0, image_error: "image tail timeout" })
  })

  it("an FMV-RPC error flips ok=false with the message surfaced", async () => {
    const spy = install({
      "rpc:populate_wmc_fmv_from_snapshots": { data: null, error: { message: "permission denied" } },
    })
    await POST(req("?collection=nba-top-shot"))
    await runDeferred()

    const log = logsFor("wmc-fmv-populate", spy.rpcCalls).at(-1)?.args as any
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("permission denied")
  })

  it("retries a transient statement-timeout on the FMV RPC and lands the good row count", async () => {
    const spy = install({
      "rpc:populate_wmc_fmv_from_snapshots": [
        { data: null, error: { message: "canceling statement due to statement timeout" } },
        { data: 9, error: null },
      ],
    })
    await POST(req("?collection=nba-top-shot"))
    await runDeferred()

    const log = logsFor("wmc-fmv-populate", spy.rpcCalls).at(-1)?.args as any
    expect(log.p_ok).toBe(true)
    expect(log.p_extra.rows_updated).toBe(9) // second attempt won
  })
})

describe("wmc-fmv-populate — guards", () => {
  it("400s an unknown collection slug and runs nothing", async () => {
    install({})
    const res = await GET(req("?collection=not_a_collection"))
    expect(res.status).toBe(400)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("401s without the token", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/wmc-fmv-populate", { method: "GET" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
