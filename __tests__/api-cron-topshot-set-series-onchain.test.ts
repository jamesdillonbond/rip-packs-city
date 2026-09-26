import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// /api/cron/topshot-set-series-onchain — fills `sets.series` (and the editions
// under each set) for Top Shot sets `catalog_topshot_from_atlas` created with
// NULL, from `TopShot.getSetSeries`. The after() body is captured and run by
// hand: heartbeat first, one script per chunk, fill-only UPDATEs keyed on
// `series IS NULL` whose written counts are the rows RETURNED, terminal row last.

let captured: (() => Promise<void>) | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { captured = fn } }
})
const heartbeat = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: (opts: unknown) => heartbeat(opts) }))
const terminal = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/terminal-run", () => ({ logTerminalRun: (opts: unknown) => terminal(opts) }))

// Chainable stub. `from(table)` records the table; `.limit()` ends the read;
// `.update()` records the patch + table and the trailing `.select("id")` answers
// from `updateResults[table]` (an array of returned ids = rows that LANDED).
const sb = vi.hoisted(() => {
  const s: any = {
    rows: [] as any[], readError: null as any,
    updates: [] as any[], updateResults: { sets: { data: [{ id: "x" }], error: null }, editions: { data: [{ id: "e1" }, { id: "e2" }], error: null } } as any,
    _table: "", _pendingUpdate: false, _in: false,
    // The stranded-editions catch-up's two reads (editions still NULL; their sets
    // that already carry a series). Default: nothing stranded.
    strandedEds: { data: [], error: null } as any, seriesedSets: { data: [], error: null } as any,
  }
  s.from = (t: string) => { s._table = t; s._in = false; return s }
  for (const m of ["eq", "is", "not", "order"]) s[m] = () => s
  s.in = () => { s._in = true; return s }
  s.limit = () => {
    if (s._table === "editions") return Promise.resolve(s.strandedEds)
    if (s._table === "sets" && s._in) return Promise.resolve(s.seriesedSets)
    return Promise.resolve(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null })
  }
  s.update = (patch: any) => { s.updates.push({ table: s._table, patch }); s._pendingUpdate = true; return s }
  s.select = () => {
    if (s._pendingUpdate) { s._pendingUpdate = false; return Promise.resolve(s.updateResults[s._table]) }
    return s
  }
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST, NOT_ON_CHAIN, decodeSeriesArray } from "@/app/api/cron/topshot-set-series-onchain/route"

function flowResult(nums: number[]) {
  const cadence = { type: "Array", value: nums.map((n) => ({ type: "UInt32", value: String(n) })) }
  return JSON.stringify({ value: Buffer.from(JSON.stringify(cadence), "utf8").toString("base64") })
}
function stubFlow(nums: number[] | null, ok = true) {
  const f = vi.fn(async () => ({
    ok, status: ok ? 200 : 503,
    json: async () => JSON.parse(flowResult(nums ?? [])),
    text: async () => (ok ? flowResult(nums ?? []) : '{ "code": 503, "message": "execution node unavailable" }'),
  }))
  vi.stubGlobal("fetch", f as any)
  return f
}

const SET_275 = { id: "s275", set_id_onchain: 275 }
const SET_140 = { id: "s140", set_id_onchain: 140 }
const GHOST = { id: "sghost", set_id_onchain: 999999 }

const saved = { cron: process.env.CRON_SECRET, ingest: process.env.INGEST_SECRET_TOKEN }
beforeEach(() => {
  process.env.CRON_SECRET = "cron-tok"
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  captured = null
  sb.rows = []; sb.readError = null; sb.updates = []; sb._pendingUpdate = false
  sb.strandedEds = { data: [], error: null }; sb.seriesedSets = { data: [], error: null }
  sb.updateResults = { sets: { data: [{ id: "x" }], error: null }, editions: { data: [{ id: "e1" }, { id: "e2" }], error: null } }
  heartbeat.mockClear(); terminal.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron
  if (saved.ingest === undefined) delete process.env.INGEST_SECRET_TOKEN; else process.env.INGEST_SECRET_TOKEN = saved.ingest
})
const req = (auth?: string) => makeReq({ url: "https://t/api/cron/topshot-set-series-onchain", auth })
const lastTerminal = () => terminal.mock.calls.at(-1)?.[0] as any

describe("authorisation — dual-secret, fail-closed", () => {
  it("accepts either bearer; 401s the rest, incl. a bare Bearer with secrets unset", async () => {
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    expect((await POST(req("Bearer ingest-tok"))).status).toBe(202)
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    delete process.env.CRON_SECRET; delete process.env.INGEST_SECRET_TOKEN
    captured = null
    expect((await GET(req("Bearer "))).status).toBe(401)
    expect(captured).toBeNull()
  })
})

describe("decodeSeriesArray", () => {
  it("decodes the [UInt32] and keeps 0 and 1 as REAL values (Series 1 is 0 on chain)", () => {
    expect(decodeSeriesArray(JSON.parse(Buffer.from(JSON.parse(flowResult([0, 1, 8])).value, "base64").toString()), 3)).toEqual([0, 1, 8])
  })
  it("throws on a shape surprise or a length mismatch", () => {
    expect(() => decodeSeriesArray({ type: "Optional", value: null }, 1)).toThrow(/Array/)
    expect(() => decodeSeriesArray({ type: "Array", value: [{ type: "UInt32", value: "8" }] }, 2)).toThrow(/1 values for 2 sets/)
  })
})

describe("the sweep", () => {
  it("heartbeat first, one script per chunk, fill-only set + editions writes, the ghost stays NULL, terminal last", async () => {
    sb.rows = [SET_140, SET_275, GHOST]
    const f = stubFlow([6, 8, NOT_ON_CHAIN])
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    await captured!()

    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat.mock.invocationCallOrder[0]).toBeLessThan((f as any).mock.invocationCallOrder[0])
    expect(f).toHaveBeenCalledTimes(1)
    const body = JSON.parse((f as any).mock.calls[0][1].body)
    const arg = JSON.parse(Buffer.from(body.arguments[0], "base64").toString("utf8"))
    expect(arg.value.map((v: any) => v.value)).toEqual(["140", "275", "999999"])

    // Two sets written (6 and 8), each followed by its editions fill; the ghost never written.
    expect(sb.updates.map((u: any) => [u.table, u.patch.series])).toEqual([["sets", 6], ["editions", 6], ["sets", 8], ["editions", 8]])

    const t = lastTerminal()
    expect(t).toMatchObject({ pipeline: "topshot-set-series-onchain", ok: true, rowsFound: 3, rowsSkipped: 1 })
    expect(t.extra).toMatchObject({ sets_written: 2, editions_written: 4, not_on_chain: 1, script_calls: 1, complete: true })
    expect(t.rowsWritten).toBe(6)
  })

  it("a set whose write landed nothing (a concurrent writer) does NOT get its editions rewritten", async () => {
    sb.rows = [SET_275]
    stubFlow([8])
    sb.updateResults.sets = { data: [], error: null }
    await GET(req("Bearer cron-tok")); await captured!()
    expect(sb.updates.map((u: any) => u.table)).toEqual(["sets"])
    expect(lastTerminal().rowsWritten).toBe(0)
  })

  it("a Flow REST failure is a FAILED run naming its error, never a quietly smaller sweep", async () => {
    sb.rows = [SET_275]
    stubFlow(null, false)
    await GET(req("Bearer cron-tok")); await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/Flow REST HTTP 503/)
    expect(sb.updates).toHaveLength(0)
  })

  it("a write error fails the run", async () => {
    sb.rows = [SET_275]
    stubFlow([8])
    sb.updateResults.sets = { data: null, error: { message: "permission denied" } }
    await GET(req("Bearer cron-tok")); await captured!()
    expect(lastTerminal()).toMatchObject({ ok: false })
    expect(String(lastTerminal().error)).toMatch(/permission denied/)
  })

  it("nothing to do is a clean, complete, zero-row run with no script called", async () => {
    sb.rows = []
    const f = stubFlow([])
    await GET(req("Bearer cron-tok")); await captured!()
    expect(f).not.toHaveBeenCalled()
    expect(lastTerminal()).toMatchObject({ ok: true, rowsFound: 0, rowsWritten: 0 })
  })
})

// Reviewed 2026-09-25: the main loop fills a set's editions only in the run that
// writes the set, and the next run no longer selects that set — so an editions
// write that failed after its set landed would strand those editions NULL for
// good. A catch-up pass runs every time, independent of this run's set writes.
describe("stranded-editions catch-up", () => {
  it("fills editions still NULL under a set that already has its series, even when no set is unseriesed", async () => {
    stubFlow([])
    sb.rows = []
    sb.strandedEds = { data: [{ set_id_onchain: 140 }, { set_id_onchain: 140 }], error: null }
    sb.seriesedSets = { data: [{ set_id_onchain: 140, series: 3 }], error: null }
    await GET(req("Bearer cron-tok"))
    await captured!()
    const edUpdates = sb.updates.filter((u: any) => u.table === "editions")
    expect(edUpdates.map((u: any) => u.patch)).toEqual([{ series: 3 }])
    expect(lastTerminal().ok).toBe(true)
    expect(lastTerminal().extra).toMatchObject({ stranded_editions_filled: 2, stranded_editions_error: null })
  })

  it("a failed catch-up read fails the run and says why — never a silent zero", async () => {
    stubFlow([])
    sb.strandedEds = { data: null, error: { message: "timeout" } }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal().ok).toBe(false)
    expect(lastTerminal().extra.stranded_editions_filled).toBeNull()
    expect(String(lastTerminal().extra.stranded_editions_error)).toContain("timeout")
  })
})

