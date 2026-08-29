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

// --- query-param handling, the refresh error arms, and the fatal catch ---

describe("wmc-fmv-populate — params + refresh degradation", () => {
  it("clamps ?limit to the 50000 default when absent, zero, or out of range", async () => {
    for (const [q, expected] of [["", 50000], ["?limit=0", 50000], ["?limit=999999999", 50000], ["?limit=abc", 50000], ["?limit=250", 250]] as const) {
      install({})
      const body = await (await GET(req(q))).json()
      expect(body.limit).toBe(expected)
      state.afterCbs.length = 0
    }
  })

  it("echoes ?force=true and reports refresh:false for a single-collection tick", async () => {
    install({})
    const body = await (await GET(req("?collection=nba-top-shot&force=true"))).json()
    expect(body.force).toBe(true)
    expect(body.refresh).toBe(false)
    expect(body.targets).toEqual(["nba-top-shot"])
    state.afterCbs.length = 0
  })

  it("?skip_refresh=true suppresses both global refreshes on a full tick", async () => {
    const spy = install({})
    const body = await (await GET(req("?skip_refresh=true"))).json()
    expect(body.refresh).toBe(false)
    await runDeferred()
    expect(rpcNames(spy.rpcCalls)).not.toContain("refresh_wmc_fmv_changed")
    expect(rpcNames(spy.rpcCalls)).not.toContain("refresh_wmc_fmv_drift_active")
  })

  // 2026-08-12 REGRESSION GUARD. Both propagation RPCs were failing with 57014 on
  // every 5-minute tick for 10+ hours while pipeline_runs showed 988 runs and ZERO
  // failures, because their only failure signal was console.log. The route returns
  // 202 regardless, so nothing DB-side could ever alert. These two tests assert the
  // failure is now RECORDED, not merely logged -- that is the whole fix.
  it("records each global refresh in pipeline_runs under its own pipeline name", async () => {
    const spy = install({
      "rpc:refresh_wmc_fmv_changed": { data: 12, error: null },
      "rpc:refresh_wmc_fmv_drift_active": { data: 7, error: null },
    })
    await POST(req())
    await runDeferred()

    const changed = logsFor("refresh_wmc_fmv_changed", spy.rpcCalls)
    const drift = logsFor("refresh_wmc_fmv_drift_active", spy.rpcCalls)
    expect(changed).toHaveLength(1)
    expect(drift).toHaveLength(1)
    expect((changed[0].args as any).p_ok).toBe(true)
    expect((changed[0].args as any).p_rows_written).toBe(12)
    expect((drift[0].args as any).p_ok).toBe(true)
    expect((drift[0].args as any).p_rows_written).toBe(7)
    // Global RPCs are not per-collection; a slug here would corrupt cadence checks.
    expect((changed[0].args as any).p_collection_slug).toBeNull()
  })

  it("a statement timeout in either refresh is written to pipeline_runs as NOT ok", async () => {
    const spy = install({
      "rpc:refresh_wmc_fmv_changed": {
        data: null,
        error: { message: "canceling statement due to statement timeout" },
      },
      "rpc:refresh_wmc_fmv_drift_active": {
        data: null,
        error: { message: "canceling statement due to statement timeout" },
      },
    })
    await POST(req())
    await runDeferred()

    for (const fn of ["refresh_wmc_fmv_changed", "refresh_wmc_fmv_drift_active"]) {
      const rows = logsFor(fn, spy.rpcCalls).map((c) => c.args as any)
      expect(rows).toHaveLength(1)
      expect(rows[0].p_ok).toBe(false)
      expect(rows[0].p_error).toMatch(/statement timeout/)
    }
    // The per-collection rows still report ok -- which is exactly why the old
    // console.log-only handling was invisible. The distinct pipeline names are what
    // make the outage detectable.
    const perColl = logsFor("wmc-fmv-populate", spy.rpcCalls).map((c) => c.args as any)
    expect(perColl.every((r) => r.p_ok !== false)).toBe(true)
  })

  // 2026-08-28. refresh_wmc_fmv_changed has TWO callers running the same
  // non-reentrant drain: pg_cron jobid 303 (`7-57/10`, MEDIAN 240s measured over
  // n=284) and this route (every 5 min, ~18s budget). The route's tick one minute
  // after each 303 firing blocked on wallet_moments_cache row locks and died --
  // 83 of 84 lock timeouts in 48h landed on :08/:18/:28/:38/:48/:58, and the six
  // even-decade minutes were clean. The RPC now returns NULL instead of blocking.
  //
  // These three tests pin the DISCRIMINATION, not the message: a skip and a
  // measured drain of zero must never collapse into the same row. That collapse is
  // one `Number(data ?? 0) || 0` away, which is what the code did before.
  it("records a NULL return as a SKIP with rows_* NULL, never as a measured zero", async () => {
    const spy = install({ "rpc:refresh_wmc_fmv_changed": { data: null, error: null } })
    await POST(req())
    await runDeferred()

    const rows = logsFor("refresh_wmc_fmv_changed", spy.rpcCalls).map((c) => c.args as any)
    expect(rows).toHaveLength(1)
    // A skip is not a failure: the other instance is draining the same cursor.
    expect(rows[0].p_ok).toBe(true)
    expect(rows[0].p_error).toBeNull()
    // The whole point. `0` here would be a fabricated measurement.
    expect(rows[0].p_rows_written).toBeNull()
    expect(rows[0].p_rows_found).toBeNull()
    expect(rows[0].p_rows_skipped).toBeNull()
    expect(rows[0].p_extra?.note).toBe("skipped_concurrent_refresh")
  })

  it("a REAL drain of zero stays a measured zero and carries no skip note", async () => {
    // The negative control for the test above. Without it, `p_rows_written: null`
    // could be satisfied by making every run NULL, and the assertion would read as
    // coverage while proving nothing.
    const spy = install({ "rpc:refresh_wmc_fmv_changed": { data: 0, error: null } })
    await POST(req())
    await runDeferred()

    const rows = logsFor("refresh_wmc_fmv_changed", spy.rpcCalls).map((c) => c.args as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].p_ok).toBe(true)
    expect(rows[0].p_rows_written).toBe(0)
    expect(rows[0].p_rows_skipped).toBe(0)
    expect(rows[0].p_extra?.note).toBeUndefined()
  })

  it("a skip does not stop the drift sweep that follows it", async () => {
    const spy = install({ "rpc:refresh_wmc_fmv_changed": { data: null, error: null } })
    await GET(req())
    await runDeferred()
    expect(rpcNames(spy.rpcCalls)).toContain("refresh_wmc_fmv_drift_active")
  })

  it("a refresh_wmc_fmv_changed error does not stop the drift sweep", async () => {
    const spy = install({ "rpc:refresh_wmc_fmv_changed": { data: null, error: { message: "refresh down" } } })
    await GET(req())
    await runDeferred()
    expect(rpcNames(spy.rpcCalls)).toContain("refresh_wmc_fmv_drift_active")
  })

  it("a drift-refresh error is swallowed (the tick still completes)", async () => {
    const spy = install({ "rpc:refresh_wmc_fmv_drift_active": { data: null, error: { message: "drift down" } } })
    await GET(req())
    await expect(runDeferred()).resolves.toBeUndefined()
    // no fatal row — an error return is not a crash
    expect(logsFor("wmc-fmv-populate", spy.rpcCalls).some((c) => (c.args as any).p_extra?.fatal)).toBe(false)
  })

  // NOTE: handle()'s outer "background pass crashed" catch is effectively
  // defensive-only — runOne() try/catches BOTH of its RPCs and its own
  // log_pipeline_run, so a thrown RPC never escapes to it. The real contract is
  // that the throw is absorbed per-collection and logged ok:false, which is
  // what this asserts. Do not chase the outer catch for coverage; reaching it
  // would require runOne to be rewritten.
  it("absorbs a thrown FMV rpc per-collection and logs ok:false (outer catch stays unreached)", async () => {
    const spy = install({})
    const fixture = spy.fixture as { rpc: (n: string, a?: unknown) => Promise<unknown> }
    const baseRpc = fixture.rpc.bind(fixture)
    fixture.rpc = async (name: string, args?: unknown) => {
      if (name === "populate_wmc_fmv_from_snapshots") throw new Error("pool exhausted")
      return baseRpc(name, args)
    }
    await GET(req("?collection=nba-top-shot"))
    await runDeferred()
    const rows = logsFor("wmc-fmv-populate", spy.rpcCalls).map((c) => c.args as any)
    expect(rows).toHaveLength(1)
    expect(rows[0].p_ok).toBe(false)
    expect(String(rows[0].p_error)).toContain("pool exhausted")
    expect(rows[0].p_extra?.fatal).toBeFalsy()
  })

  it("POST is an alias for GET and reaches the same 202", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/wmc-fmv-populate", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer wmc-token" }),
    }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    state.afterCbs.length = 0
  })
})
