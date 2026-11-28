import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET/POST /api/cron/top-collector-census-dune — the full holder census behind
// the Top Collector Leaderboard. Pins:
//   - auth guard (401) and the refused-not-substituted collection param (400);
//   - unconfigured Dune logs ok:false and 503s (no walk);
//   - the happy path: map → upload → execute → status → results → stage → finalize,
//     logged ok:true with rows_written = what the stage reported;
//   - every failure face fails the RUN (ok:false, written 0) and drops the stage:
//     an unkeyed row, a short walk, a foreign execution id, a finalize refusal;
//   - ?execution_id= resume skips map/upload/execute.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  deletes: [] as Array<{ table: string; col: string; val: unknown }>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: vi.fn(async () => undefined) }))
vi.mock("@/lib/dune/budget", () => ({ recordDuneUsage: vi.fn(async () => undefined) }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args })
      const h = state.rpc[name]
      return h ? h(args) : { data: null, error: null }
    },
    from: (table: string) => ({
      delete: () => ({
        eq: async (col: string, val: unknown) => {
          state.deletes.push({ table, col, val })
          return { error: null }
        },
      }),
    }),
  },
}))

const mod = await import("@/app/api/cron/top-collector-census-dune/route")

const MAP_CSV = '"kind","key"\n"player","1"\n"team","x"\n'
const OWNER = "0x0123456789abcdef"
const row = (over: Record<string, unknown> = {}) => ({
  entity_kind: "player",
  entity_key: "123",
  owner: OWNER,
  items: 5,
  special_items: 1,
  fmv_usd: 12.5,
  fmv_items: 5,
  holders: 40,
  entity_items: 300,
  entity_special: 9,
  ...over,
})

type Resp = { status?: number; json?: unknown; text?: string }
function stubProxy(routes: { upload?: Resp; execute?: Resp; status?: Resp[]; results?: Resp[] }) {
  const idx = { status: 0, results: 0 }
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      let r: Resp
      if (url.includes("/upload_csv")) r = routes.upload ?? { json: { success: true } }
      else if (url.includes("/execute")) r = routes.execute ?? { json: { execution_id: "EX1" } }
      else if (url.includes("/status")) {
        const l = routes.status ?? [{ json: { state: "QUERY_STATE_COMPLETED" } }]
        r = l[Math.min(idx.status++, l.length - 1)]
      } else {
        const l = routes.results ?? [{ json: { execution_id: "EX1", result: { rows: [], metadata: { total_row_count: 0 } } } }]
        r = l[Math.min(idx.results++, l.length - 1)]
      }
      const status = r.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => r.json ?? {},
        text: async () => r.text ?? JSON.stringify(r.json ?? {}),
      } as unknown as Response
    }),
  )
  return calls
}

function req(query: string, auth: string | null = "Bearer test-ingest-token"): NextRequest {
  return new NextRequest(`https://x.test/api/cron/top-collector-census-dune${query}`, {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) {
    let settled = false
    const p = Promise.resolve()
      .then(cb)
      .finally(() => {
        settled = true
      })
    let guard = 0
    while (!settled) {
      if (++guard > 500) throw new Error("after() work did not settle")
      await vi.advanceTimersByTimeAsync(15_000)
    }
    await p
  }
}

const logArgs = () => state.rpcCalls.find((c) => c.name === "log_pipeline_run")?.args as { p_ok: boolean; p_rows_found: number; p_rows_written: number; p_error: string | null; p_extra: Record<string, unknown> }

function happyRpcs() {
  state.rpc.top_collector_census_map_csv = () => ({ data: MAP_CSV, error: null })
  state.rpc.stage_top_collector_census = (a) => ({ data: (a.p_rows as unknown[]).length, error: null })
  state.rpc.finalize_top_collector_census = () => ({ data: { ok: true, rows: 2 }, error: null })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
  process.env.CRON_SECRET = "test-cron-secret"
  process.env.DUNE_PROXY_URL = "https://dune-proxy.example/"
  process.env.DUNE_PROXY_SECRET = "s"
  state.afterCbs.length = 0
  state.rpc = {}
  state.rpcCalls = []
  state.deletes = []
  vi.useFakeTimers()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete process.env.TOP_COLLECTOR_CENSUS_QUERY_TOPSHOT
})

describe("top-collector-census-dune — gates", () => {
  it("401s without a bearer", async () => {
    expect((await mod.POST(req("?collection=nba-top-shot", null))).status).toBe(401)
  })
  it("401s with a wrong bearer", async () => {
    expect((await mod.GET(req("?collection=nba-top-shot", "Bearer nope"))).status).toBe(401)
  })
  it("refuses an absent collection rather than defaulting one", async () => {
    const res = await mod.POST(req(""))
    expect(res.status).toBe(400)
    expect(state.afterCbs).toHaveLength(0)
  })
  it("refuses a collection the census does not cover (no substitution)", async () => {
    const res = await mod.POST(req("?collection=candy-mlb"))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain("candy")
  })
  it("503s and logs ok:false when Dune is unconfigured", async () => {
    delete process.env.DUNE_PROXY_URL
    const res = await mod.POST(req("?collection=nba-top-shot"))
    expect(res.status).toBe(503)
    expect(logArgs().p_ok).toBe(false)
    expect(logArgs().p_extra.skipped).toBe("dune_not_configured")
    expect(state.afterCbs).toHaveLength(0)
  })
  it("503s when the query-id override is not numeric", async () => {
    process.env.TOP_COLLECTOR_CENSUS_QUERY_TOPSHOT = "abc"
    expect((await mod.POST(req("?collection=nba-top-shot"))).status).toBe(503)
  })
})

describe("top-collector-census-dune — the walk", () => {
  it("happy path: upload → execute → page → stage → finalize, logged ok with written = staged", async () => {
    happyRpcs()
    const calls = stubProxy({
      results: [{ json: { execution_id: "EX1", result: { rows: [row(), row({ entity_kind: "team", entity_key: "blazers" })], metadata: { total_row_count: 2, column_names: ["a"] } } } }],
    })
    const res = await mod.POST(req("?collection=nba-top-shot"))
    expect(res.status).toBe(202)
    await runDeferred()
    expect(calls.some((u) => u.includes("/upload_csv"))).toBe(true)
    expect(calls.some((u) => u.includes("/execute?query_id="))).toBe(true)
    expect(calls[0].startsWith("https://dune-proxy.example/upload_csv")).toBe(true) // trailing slash stripped
    const fin = state.rpcCalls.find((c) => c.name === "finalize_top_collector_census")!
    expect(fin.args.p_expected_rows).toBe(2)
    const log = logArgs()
    expect(log.p_ok).toBe(true)
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(2)
    expect(log.p_extra.execution_id).toBe("EX1")
    expect(state.deletes).toHaveLength(0)
  })

  it("pages past the first 1,000 rows", async () => {
    happyRpcs()
    const page1 = Array.from({ length: 1000 }, (_, i) => row({ entity_key: String(i) }))
    stubProxy({
      results: [
        { json: { execution_id: "EX1", next_offset: 1000, result: { rows: page1, metadata: { total_row_count: 1001 } } } },
        { json: { execution_id: "EX1", result: { rows: [row({ entity_key: "last" })], metadata: { total_row_count: 1001 } } } },
      ],
    })
    await mod.POST(req("?collection=nfl-all-day"))
    await runDeferred()
    expect(logArgs().p_ok).toBe(true)
    expect(logArgs().p_rows_written).toBe(1001)
  })

  it("resume (?execution_id=) skips map, upload and execute", async () => {
    happyRpcs()
    const calls = stubProxy({ results: [{ json: { execution_id: "EX9", result: { rows: [row()], metadata: { total_row_count: 1 } } } }] })
    await mod.POST(req("?collection=disney-pinnacle&execution_id=EX9"))
    await runDeferred()
    expect(calls.every((u) => u.includes("/results"))).toBe(true)
    expect(state.rpcCalls.some((c) => c.name === "top_collector_census_map_csv")).toBe(false)
    expect(logArgs().p_ok).toBe(true)
    expect(logArgs().p_extra.resumed).toBe(true)
  })

  it("an unkeyed row fails the run, writes nothing and drops the stage", async () => {
    happyRpcs()
    stubProxy({ results: [{ json: { execution_id: "EX1", result: { rows: [row(), row({ owner: "not-an-address" })], metadata: { total_row_count: 2 } } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    const log = logArgs()
    expect(log.p_ok).toBe(false)
    expect(log.p_rows_written).toBe(0)
    expect(log.p_error).toMatch(/could not be keyed/)
    expect(state.rpcCalls.some((c) => c.name === "finalize_top_collector_census")).toBe(false)
    expect(state.deletes[0]).toMatchObject({ table: "entity_top_fans_census_stage", col: "run_id" })
  })

  it("a short walk (found ≠ total_row_count) fails the run", async () => {
    happyRpcs()
    stubProxy({ results: [{ json: { execution_id: "EX1", result: { rows: [row()], metadata: { total_row_count: 5 } } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_ok).toBe(false)
    expect(logArgs().p_error).toMatch(/received 1 of 5/)
  })

  it("results from a different execution are refused, never paged as current", async () => {
    happyRpcs()
    stubProxy({ results: [{ json: { execution_id: "OLD", result: { rows: [row()] } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_ok).toBe(false)
    expect(logArgs().p_error).toMatch(/belong to execution OLD/)
  })

  it("a finalize refusal fails the run", async () => {
    happyRpcs()
    state.rpc.finalize_top_collector_census = () => ({ data: { ok: false, error: "short stage" }, error: null })
    stubProxy({ results: [{ json: { execution_id: "EX1", result: { rows: [row()], metadata: { total_row_count: 1 } } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_ok).toBe(false)
    expect(logArgs().p_error).toMatch(/finalize refused: short stage/)
  })

  it("a stage error fails the run", async () => {
    happyRpcs()
    state.rpc.stage_top_collector_census = () => ({ data: null, error: { message: "boom" } })
    stubProxy({ results: [{ json: { execution_id: "EX1", result: { rows: [row()], metadata: { total_row_count: 1 } } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toBe("stage: boom")
  })

  it("an empty map is refused before anything is uploaded", async () => {
    state.rpc.top_collector_census_map_csv = () => ({ data: '"h"\n', error: null })
    const calls = stubProxy({})
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(calls).toHaveLength(0)
    expect(logArgs().p_error).toBe("map: empty")
  })

  it("a map RPC error fails the run", async () => {
    state.rpc.top_collector_census_map_csv = () => ({ data: null, error: { message: "timeout" } })
    stubProxy({})
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toBe("map: timeout")
  })

  it("an upload HTTP error fails the run before execute", async () => {
    happyRpcs()
    const calls = stubProxy({ upload: { status: 413, text: "too big" } })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toMatch(/upload HTTP 413: too big/)
    expect(calls.some((u) => u.includes("/execute"))).toBe(false)
  })

  it("an execute with no execution_id fails the run", async () => {
    happyRpcs()
    stubProxy({ execute: { status: 402, json: { error: "out of credits" } } })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toMatch(/execute HTTP 402: out of credits/)
  })

  it("a FAILED execution fails the run", async () => {
    happyRpcs()
    stubProxy({ status: [{ json: { state: "QUERY_STATE_EXECUTING" } }, { json: { state: "QUERY_STATE_FAILED", error: { message: "x" } } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toMatch(/execution QUERY_STATE_FAILED/)
  })

  it("an execution outliving the status budget names its id for resume", async () => {
    happyRpcs()
    stubProxy({ status: [{ json: { state: "QUERY_STATE_EXECUTING" } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toMatch(/resume with \?execution_id=EX1/)
  })

  it("a results HTTP error fails the run", async () => {
    happyRpcs()
    stubProxy({ results: [{ status: 500, json: { error: "upstream" } }] })
    await mod.POST(req("?collection=nba-top-shot"))
    await runDeferred()
    expect(logArgs().p_error).toMatch(/results HTTP 500: upstream/)
  })
})
