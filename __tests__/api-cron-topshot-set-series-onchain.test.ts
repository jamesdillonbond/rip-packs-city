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
    // The new-series registration's reads (series present on sets; series already
    // in collection_series) and its upsert. Default: no series reads at all.
    seriesCensus: null as any, knownSeries: { data: [], error: null } as any,
    upserts: [] as any[], upsertResult: { data: [], error: null } as any,
    _sel: "", _pendingUpsert: false,
    // The play-metadata pass's read (editions still missing game_date). Default: none.
    playMetaEds: { data: [], error: null } as any,
  }
  s.from = (t: string) => { s._table = t; s._in = false; s._sel = ""; return s }
  for (const m of ["eq", "is", "not", "order", "or"]) s[m] = () => s
  s.in = () => { s._in = true; return s }
  s.limit = () => {
    if (s._table === "sets" && s._sel === "series") return Promise.resolve(s.seriesCensus ?? { data: [], error: null })
    if (s._table === "collection_series") return Promise.resolve(s.knownSeries)
    if (s._table === "editions" && s._sel.includes("play_id_onchain")) return Promise.resolve(s.playMetaEds)
    if (s._table === "editions") return Promise.resolve(s.strandedEds)
    if (s._table === "sets" && s._in) return Promise.resolve(s.seriesedSets)
    return Promise.resolve(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null })
  }
  s.range = () => s.limit()
  s.update = (patch: any) => { s.updates.push({ table: s._table, patch }); s._pendingUpdate = true; return s }
  s.upsert = (rows: any, opts: any) => { s.upserts.push({ table: s._table, rows, opts }); s._pendingUpsert = true; return s }
  s.select = (cols?: string) => {
    if (s._pendingUpdate) { s._pendingUpdate = false; return Promise.resolve(s.updateResults[s._table]) }
    if (s._pendingUpsert) { s._pendingUpsert = false; return Promise.resolve(s.upsertResult) }
    s._sel = cols ?? ""
    return s
  }
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST, NOT_ON_CHAIN, decodeSeriesArray, decodePlayMetaArray, toGameDate, toJersey } from "@/app/api/cron/topshot-set-series-onchain/route"

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
  sb.seriesCensus = null; sb.knownSeries = { data: [], error: null }; sb.upserts = []; sb.upsertResult = { data: [], error: null }
  sb._pendingUpsert = false
  sb.playMetaEds = { data: [], error: null }
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



// 2026-10-15: a new Top Shot series gets its collection_series row (series page,
// Collection-tab filter, sitemap) — only under a label the canonical map knows.
describe("topshot-set-series-onchain — registers a new series", () => {
  async function runOnce() {
    stubFlow([])
    const res = await GET(req("Bearer cron-tok"))
    expect(res.status).toBe(202)
    await captured!()
    return (terminal.mock.calls.at(-1)?.[0] ?? {}) as any
  }

  it("registers a labelled series the sets carry and the table lacks, with its label and season", async () => {
    sb.seriesCensus = { data: [{ series: 8 }, { series: 9 }, { series: 9 }], error: null }
    sb.knownSeries = { data: [{ series_number: 8 }], error: null }
    sb.upsertResult = { data: [{ series_number: 9 }], error: null }
    const t = await runOnce()
    expect(sb.upserts).toHaveLength(1)
    expect(sb.upserts[0].table).toBe("collection_series")
    expect(sb.upserts[0].rows).toEqual([
      { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", series_number: 9, display_label: "Series 2026-27", season: "2026-27" },
    ])
    expect(sb.upserts[0].opts).toMatchObject({ onConflict: "collection_id,series_number", ignoreDuplicates: true })
    expect(t.ok).toBe(true)
    expect(t.extra).toMatchObject({ series_registered: [9], unlabelled_series: [], register_error: null })
  })

  it("NO-CHANGE CONTROL: every present series already registered writes nothing", async () => {
    sb.seriesCensus = { data: [{ series: 0 }, { series: 8 }], error: null }
    sb.knownSeries = { data: [{ series_number: 0 }, { series_number: 8 }], error: null }
    const t = await runOnce()
    expect(sb.upserts).toHaveLength(0)
    expect(t.ok).toBe(true)
    expect(t.extra).toMatchObject({ series_registered: [], unlabelled_series: [] })
  })

  it("a series with NO known label is not guessed: nothing written, the run fails and names it", async () => {
    sb.seriesCensus = { data: [{ series: 8 }, { series: 42 }], error: null }
    sb.knownSeries = { data: [{ series_number: 8 }], error: null }
    const t = await runOnce()
    expect(sb.upserts).toHaveLength(0)
    expect(t.ok).toBe(false)
    expect(String(t.error)).toContain("42")
    expect(t.extra).toMatchObject({ unlabelled_series: [42] })
  })

  it("a failed collection_series read fails the run without writing", async () => {
    sb.seriesCensus = { data: [{ series: 9 }], error: null }
    sb.knownSeries = { data: null, error: { message: "permission denied" } }
    const t = await runOnce()
    expect(sb.upserts).toHaveLength(0)
    expect(t.ok).toBe(false)
    expect(t.extra.register_error).toContain("collection_series read failed")
  })
})

// ── Play metadata pass (2026-10-21) ─────────────────────────────────────────
// Editions the Atlas catalog created with NULL game_date / play_type /
// play_category / jersey_number get them from TopShot.getPlayMetaData, fill-only.

const opt = (v: string | null) => ({ type: "Optional", value: v == null ? null : { type: "String", value: v } })
const row4 = (d: string | null, t: string | null, c: string | null, j: string | null) => ({ type: "Array", value: [opt(d), opt(t), opt(c), opt(j)] })
// The JSON-Cadence shapes Flow REST returned on 10-21 (play 9318, an old ISO play,
// a Reel with nothing, a US-format date with "00", and the literal "<invalid Value>").
const REAL_SHAPE = {
  type: "Array",
  value: [
    row4("2026-10-20T23:00:00Z", "3 Pointer", "3 Pointer", "7"),
    row4("2022-10-23 02:00:00 +0000 UTC", "Rim", "Layup", "88"),
    row4(null, "Reel", "Reel", null),
  ],
}
const ed = (play: number, over: Partial<{ game_date: string | null; play_type: string | null; play_category: string | null; jersey_number: number | null }> = {}) =>
  ({ id: `e${play}-${Math.random()}`, play_id_onchain: play, game_date: null, play_type: null, play_category: null, jersey_number: null, ...over })
function stubPlayMeta(shape: unknown, ok = true) {
  const payload = JSON.stringify({ value: Buffer.from(JSON.stringify(shape), "utf8").toString("base64") })
  const f = vi.fn(async () => ({
    ok, status: ok ? 200 : 503,
    json: async () => JSON.parse(payload),
    text: async () => (ok ? payload : "execution node unavailable"),
  }))
  vi.stubGlobal("fetch", f as any)
  return f
}

describe("toGameDate / toJersey / decodePlayMetaArray", () => {
  it("takes the UTC calendar date in all three on-chain formats; junk is null, never a guessed date", () => {
    expect(toGameDate("2026-10-20T23:00:00Z")).toBe("2026-10-20")
    expect(toGameDate("2022-10-23 02:00:00 +0000 UTC")).toBe("2022-10-23")
    // The third on-chain format (191 plays on 10-21, e.g. 9305): US month/day/year, no time.
    expect(toGameDate("9/27/2026")).toBe("2026-09-27")
    expect(toGameDate("10/2/2026")).toBe("2026-10-02")
    expect(toGameDate("13/2/2026")).toBeNull()
    expect(toGameDate("")).toBeNull()
    expect(toGameDate("Oct 20")).toBeNull()
    expect(toGameDate(null)).toBeNull()
  })
  it("reads a jersey only from a 1–3 digit string: '00' is 0, '<invalid Value>' is null", () => {
    expect(toJersey("7")).toBe(7)
    expect(toJersey("00")).toBe(0)
    expect(toJersey("<invalid Value>")).toBeNull()
    expect(toJersey("")).toBeNull()
    expect(toJersey("1234")).toBeNull()
    expect(toJersey(null)).toBeNull()
  })
  it("decodes the real Flow REST shape, and a play with no metadata decodes to nulls", () => {
    expect(decodePlayMetaArray(REAL_SHAPE, 3)).toEqual([
      { gameDate: "2026-10-20", playType: "3 Pointer", playCategory: "3 Pointer", jersey: 7 },
      { gameDate: "2022-10-23", playType: "Rim", playCategory: "Layup", jersey: 88 },
      { gameDate: null, playType: "Reel", playCategory: "Reel", jersey: null },
    ])
  })
  it("throws on a shape surprise or a length mismatch", () => {
    expect(() => decodePlayMetaArray({ type: "Optional", value: null }, 1)).toThrow(/Array/)
    expect(() => decodePlayMetaArray({ type: "Array", value: [{ type: "Array", value: [opt("x")] }] }, 1)).toThrow(/4-element/)
    expect(() => decodePlayMetaArray(REAL_SHAPE, 2)).toThrow(/3 rows for 2 plays/)
  })
})

describe("the play-metadata pass", () => {
  it("fills only the columns a play's editions lack, keyed on that column being NULL; nothing is guessed", async () => {
    sb.playMetaEds = { data: [
      ed(9318), ed(9318),
      ed(2956, { play_type: "Rim", play_category: "Layup", jersey_number: 88 }), // only the date is missing
      ed(4000, { game_date: "2023-01-01", play_type: "Reel", play_category: "Reel" }), // only the jersey, and the chain has none
    ], error: null }
    // Plays are asked newest first: 9318, 4000, 2956 — the chain answers in that order.
    const f = stubPlayMeta({ type: "Array", value: [REAL_SHAPE.value[0], REAL_SHAPE.value[2], REAL_SHAPE.value[1]] })
    await GET(req("Bearer cron-tok")); await captured!()

    expect(f).toHaveBeenCalledTimes(1)
    const arg = JSON.parse(Buffer.from(JSON.parse((f as any).mock.calls[0][1].body).arguments[0], "base64").toString("utf8"))
    expect(arg.value.map((v: any) => v.value)).toEqual(["9318", "4000", "2956"])

    const eds = sb.updates.filter((u: any) => u.table === "editions").map((u: any) => u.patch)
    expect(eds).toEqual(expect.arrayContaining([
      { game_date: "2026-10-20" }, { play_type: "3 Pointer" }, { play_category: "3 Pointer" }, { jersey_number: 7 },
      { game_date: "2022-10-23" },
    ]))
    expect(eds).not.toContainEqual({ play_type: "Rim" })
    expect(eds).not.toContainEqual({ jersey_number: 88 })
    expect(eds).toHaveLength(5)

    const t = lastTerminal()
    expect(t.ok).toBe(true)
    expect(t.extra.play_meta).toMatchObject({
      plays: 3, no_date: 0, no_jersey: 1, editions_dated: 4, editions_jerseyed: 2,
      editions_typed: 2, editions_categorised: 2, script_calls: 1, script_errors: 0, complete: true,
    })
  })

  it("plays go newest first, so a launch day's plays lead", async () => {
    sb.playMetaEds = { data: [ed(3000), ed(9320), ed(5000)], error: null }
    const f = stubPlayMeta({ type: "Array", value: [row4(null, null, null, null), row4(null, null, null, null), row4(null, null, null, null)] })
    await GET(req("Bearer cron-tok")); await captured!()
    const arg = JSON.parse(Buffer.from(JSON.parse((f as any).mock.calls[0][1].body).arguments[0], "base64").toString("utf8"))
    expect(arg.value.map((v: any) => v.value)).toEqual(["9320", "5000", "3000"])
    expect(lastTerminal().extra.play_meta).toMatchObject({ no_date: 3, no_jersey: 3, editions_dated: 0 })
  })

  it("a Flow REST failure FAILS the run and writes nothing — never a 'nothing to fill'", async () => {
    sb.playMetaEds = { data: [ed(9318)], error: null }
    stubPlayMeta(REAL_SHAPE, false)
    await GET(req("Bearer cron-tok")); await captured!()
    expect(sb.updates.filter((u: any) => u.table === "editions")).toHaveLength(0)
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(t.error).toMatch(/play-meta flow rest: Flow REST HTTP 503/)
    expect(t.extra.play_meta).toMatchObject({ script_errors: 1, editions_dated: 0 })
  })

  it("a failed read fails the run and is reported as the read failing", async () => {
    sb.playMetaEds = { data: null, error: { message: "boom" } }
    stubPlayMeta(REAL_SHAPE)
    await GET(req("Bearer cron-tok")); await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(t.extra.play_meta).toBeNull()
    expect(t.extra.play_meta_error).toMatch(/play-meta editions read failed: boom/)
  })

  it("a write error fails the run; the count is rows that LANDED", async () => {
    sb.playMetaEds = { data: [ed(9318, { play_type: "3 Pointer", play_category: "3 Pointer", jersey_number: 7 })], error: null }
    stubPlayMeta({ type: "Array", value: [REAL_SHAPE.value[0]] })
    sb.updateResults.editions = { data: null, error: { message: "deadlock" } }
    await GET(req("Bearer cron-tok")); await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(t.extra.play_meta).toMatchObject({ editions_dated: 0, write_errors: 1 })
  })
})
