import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Four small admin/cron routes that share one shape — sync auth, then a
// deferred `after()` body — and therefore one blind spot: their existing tests
// stop at the 401/202, so the work itself has never run. That is the exact
// silent-run class the 2026-06-10/06-11 dark-run incidents came from: the route
// answers 202, the cron entry stays enabled, and nothing ever happened.
//
// What each deferred body must guarantee:
//   refresh-error-triage — writes a pipeline_runs row on EVERY outcome (that
//     row is the success signal now that the HTTP response is always 202), with
//     ok:false + the message when the rebuild RPC fails.
//   prune-pipeline-runs — the 7-day retention is passed as `p_retention_days`,
//     NOT the `p_keep_days` the original spec suggested; a wrong arg name is a
//     silent no-op against a SECDEF RPC.
//   drain-fmv-cold-tail — a slug that THROWS (pool timeout, not a returned
//     error) must not abort the loop before the pipeline_runs insert, and
//     Pinnacle must stay excluded (it has its own per-render engine).
//   migrate-acquired-at — the exec_sql → execute_sql fallback ladder.

const state = vi.hoisted(() => ({
  after: [] as Array<() => unknown>,
  rpc: {} as Record<string, { data?: unknown; error?: unknown; throws?: string }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertThrows: false,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.after.push(cb) }
})

const client = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ name, args })
    const r = state.rpc[name] ?? { data: { ok: true }, error: null }
    if (r.throws) throw new Error(r.throws)
    return { data: r.data ?? null, error: r.error ?? null }
  },
  from: (table: string) => ({
    insert: async (row: Record<string, unknown>) => {
      if (state.insertThrows) throw new Error("pipeline_runs insert down")
      state.inserts.push({ table, row })
      return { error: null }
    },
    update: () => ({ error: null }),
  }),
  raw: (s: string) => s,
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: client }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => client }))

process.env.INGEST_SECRET_TOKEN = "ingest-tok"
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://x.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"

const triage = await import("@/app/api/admin/cron/refresh-error-triage/route")
const prune = await import("@/app/api/admin/prune-pipeline-runs/route")
const drain = await import("@/app/api/admin/drain-fmv-cold-tail/route")
const migrate = await import("@/app/api/migrate-acquired-at/route")

function req(path: string, opts: { auth?: string; qs?: string } = {}) {
  return new NextRequest(`https://t${path}${opts.qs ?? ""}`, {
    method: "POST",
    headers: new Headers(opts.auth ? { authorization: opts.auth } : {}),
  })
}
const authed = (path: string, qs?: string) => req(path, { auth: "Bearer ingest-tok", qs })

async function runDeferred() {
  const cbs = [...state.after]
  state.after.length = 0
  for (const cb of cbs) await cb()
}

const rpcArgs = (name: string) => state.rpcCalls.find((c) => c.name === name)?.args
const logRow = () => state.rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args

beforeEach(() => {
  state.after.length = 0
  state.rpc = {}
  state.rpcCalls = []
  state.inserts = []
  state.insertThrows = false
})

describe("refresh-error-triage — the deferred rebuild", () => {
  const P = "/api/admin/cron/refresh-error-triage"

  it("401s without the bearer and queues nothing", async () => {
    expect((await triage.POST(req(P))).status).toBe(401)
    expect((await triage.POST(req(P, { auth: "Bearer wrong" }))).status).toBe(401)
    expect(state.after).toHaveLength(0)
  })

  it("202s, rebuilds the 14-day rollup, and logs ok:true", async () => {
    const res = await triage.POST(authed(P))
    expect(res.status).toBe(202)
    await runDeferred()

    expect(rpcArgs("refresh_error_triage")).toEqual({ p_lookback: "14 days" })
    expect(logRow()).toMatchObject({ p_pipeline: "refresh-error-triage", p_ok: true, p_error: null })
  })

  it("still writes the pipeline_runs row with ok:false when the rebuild errors", async () => {
    state.rpc.refresh_error_triage = { data: null, error: { message: "rollup rpc down" } }
    await triage.POST(authed(P))
    await runDeferred()
    // The 202 already went out, so this row is the ONLY failure signal.
    expect(logRow()).toMatchObject({ p_ok: false, p_error: "rollup rpc down" })
  })

  it("still writes the row when the rebuild THROWS", async () => {
    state.rpc.refresh_error_triage = { throws: "pool timeout" }
    await triage.POST(authed(P))
    await runDeferred()
    expect(logRow()).toMatchObject({ p_ok: false, p_error: "pool timeout" })
  })

  it("survives a failing log_pipeline_run without rejecting the deferred body", async () => {
    state.rpc.log_pipeline_run = { throws: "logger down" }
    await triage.POST(authed(P))
    await expect(runDeferred()).resolves.not.toThrow()
  })
})

describe("prune-pipeline-runs — the deferred prune", () => {
  const P = "/api/admin/prune-pipeline-runs"

  it("401s without the bearer", async () => {
    expect((await prune.POST(req(P))).status).toBe(401)
    expect(state.after).toHaveLength(0)
  })

  it("passes the 7-day retention as p_retention_days (NOT p_keep_days)", async () => {
    const body = await (await prune.POST(authed(P))).json()
    expect(body).toMatchObject({ ok: true, queued: true, keep_days: 7 })
    await runDeferred()
    // A wrong arg name is a silent no-op against the SECDEF RPC.
    expect(rpcArgs("prune_pipeline_runs")).toEqual({ p_retention_days: 7 })
  })

  it("swallows an RPC error and an RPC throw (fire-and-forget)", async () => {
    state.rpc.prune_pipeline_runs = { data: null, error: { message: "delete blocked" } }
    await prune.POST(authed(P))
    await expect(runDeferred()).resolves.not.toThrow()

    state.rpc.prune_pipeline_runs = { throws: "connection reset" }
    await prune.POST(authed(P))
    await expect(runDeferred()).resolves.not.toThrow()
  })
})

describe("drain-fmv-cold-tail — collection gating + the deferred drain", () => {
  const P = "/api/admin/drain-fmv-cold-tail"

  it("accepts either auth lane and rejects a wrong token", async () => {
    expect((await drain.POST(authed(P))).status).toBe(202)
    expect((await drain.POST(req(P, { qs: "?token=ingest-tok" }))).status).toBe(202)
    expect((await drain.POST(req(P, { qs: "?token=nope" }))).status).toBe(401)
  })

  it("400s Pinnacle explicitly — it has its own per-render engine", async () => {
    const res = await drain.POST(authed(P, "?collection=disney_pinnacle"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("pinnacle_fmv_recalc")
    expect(state.after).toHaveLength(0)
  })

  it("400s an unsupported collection and lists the supported set", async () => {
    const res = await drain.POST(authed(P, "?collection=candy_mlb"))
    expect(res.status).toBe(400)
    expect((await res.json()).supported).toEqual([
      "nba_top_shot", "nfl_all_day", "laliga_golazos", "ufc_strike", "all",
    ])
  })

// The route writes TWO pipeline_runs rows per tick: an invocation heartbeat under
// `drain-fmv-cold-tail-heartbeat` FIRST (so a killed tick is still visible), then
// the real run. `find(i => i.table === "pipeline_runs")` returns the FIRST match,
// which is the heartbeat -- and its ok is unconditionally true, so asserting on it
// reads a success out of a wholly failed drain. Always select the run by NAME.
const drainRow = (state: { inserts: Array<{ table: string; row: any }> }) =>
  state.inserts.find((i) => i.table === "pipeline_runs" && i.row.pipeline === "drain-fmv-cold-tail")!.row

  it("drains all four stale collections by default and records each result", async () => {
    await drain.POST(authed(P))
    await runDeferred()

    const slugs = state.rpcCalls.filter((c) => c.name === "drain_fmv_cold_tail").map((c) => c.args.p_collection_slug)
    // ⚠ ORDER-INSENSITIVE ON PURPOSE. The route rotates which slug goes first
    // every tick (2026-08-18), so asserting a fixed order pins the rotation
    // rather than the drain. What must hold is that all four are attempted
    // exactly once -- [...].sort() keeps that strict (a dropped or duplicated
    // slug still fails); it only stops the rotation itself reddening this.
    expect([...slugs].sort()).toEqual(["laliga_golazos", "nba_top_shot", "nfl_all_day", "ufc_strike"])
    const row = drainRow(state)
    expect(row).toMatchObject({ pipeline: "drain-fmv-cold-tail", ok: true })
    expect((row.extra as { results: unknown[] }).results).toHaveLength(4)
  })

  it("clamps the limit to [1,500] and defaults a non-numeric one to 200", async () => {
    for (const [qs, expected] of [["?limit=9999", 500], ["?limit=0", 1], ["?limit=abc", 200], ["", 200]] as const) {
      state.rpcCalls = []
      await drain.POST(authed(P, `?collection=ufc_strike${qs ? "&" + qs.slice(1) : ""}`))
      await runDeferred()
      expect(rpcArgs("drain_fmv_cold_tail")?.p_limit, qs).toBe(expected)
    }
  })

  it("a slug that THROWS does not abort the loop before the pipeline_runs insert", async () => {
    // The 2026-06-11 fix: a pool-timeout THROW on one collection used to reject
    // the whole after() and the run produced no row at all.
    state.rpc.drain_fmv_cold_tail = { throws: "Timed out acquiring connection" }
    await drain.POST(authed(P))
    await runDeferred()

    const row = drainRow(state)
    expect(row.ok).toBe(false)
    const results = (row.extra as { results: Array<{ ok: boolean; error: string }> }).results
    expect(results).toHaveLength(4) // every slug still attempted + recorded
    expect(results.every((r) => !r.ok && r.error.includes("Timed out"))).toBe(true)
  })

  it("marks the run not-ok when a slug returns an error, and survives a failing insert", async () => {
    state.rpc.drain_fmv_cold_tail = { data: null, error: { message: "drain rpc down" } }
    await drain.POST(authed(P, "?collection=nba_top_shot"))
    await runDeferred()
    expect(drainRow(state).ok).toBe(false)

    state.insertThrows = true
    await drain.POST(authed(P, "?collection=nba_top_shot"))
    await expect(runDeferred()).resolves.not.toThrow()
  })
})

describe("migrate-acquired-at — the exec_sql fallback ladder", () => {
  const P = "/api/migrate-acquired-at"

  it("401s without the bearer", async () => {
    expect((await migrate.POST(req(P))).status).toBe(401)
  })

  it("reports the updated count from the primary exec_sql path", async () => {
    state.rpc.exec_sql = { data: [{ updated_count: 512 }], error: null }
    const body = await (await migrate.POST(authed(P))).json()
    expect(body).toEqual({ status: "ok", updatedCount: 512 })
  })

  it("falls back to execute_sql when exec_sql errors", async () => {
    state.rpc.exec_sql = { data: null, error: { message: "no such function" } }
    state.rpc.execute_sql = { data: null, error: null }
    const body = await (await migrate.POST(authed(P))).json()
    expect(body).toMatchObject({ status: "ok", message: expect.stringContaining("execute_sql") })
    expect(state.rpcCalls.map((c) => c.name)).toContain("execute_sql")
  })

  it("500s when BOTH lanes fail", async () => {
    state.rpc.exec_sql = { data: null, error: { message: "primary down" } }
    state.rpc.execute_sql = { data: null, error: { message: "fallback down" } }
    const res = await migrate.POST(authed(P))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("fallback down")
  })

  it("500s with the message when the whole thing throws", async () => {
    state.rpc.exec_sql = { throws: "connection refused" }
    const res = await migrate.POST(authed(P))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("connection refused")
  })
})
