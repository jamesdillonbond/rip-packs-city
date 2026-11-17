import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"
import type { DistImagePassResult } from "@/lib/packs/topshot-dist-images"

// /api/cron/topshot-pack-dist-names-onchain — names Top Shot pack
// distributions the dead GraphQL catalog left with `title NULL`, from the PDS
// contract. The after() body is captured and run by hand: heartbeat first, one
// PDS script per unnamed dist, a fill-only UPDATE keyed on `title IS NULL`, a
// terminal row last whose written count is the rows the UPDATE returned.

let captured: (() => Promise<void>) | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { captured = fn } }
})
const heartbeat = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: (opts: unknown) => heartbeat(opts) }))
const terminal = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/terminal-run", () => ({ logTerminalRun: (opts: unknown) => terminal(opts) }))
// The image pass has its own suite (lib-topshot-dist-images); here it is a stub
// whose result the route must fold into ok / counts / extra.
const IMAGES_CLEAN: DistImagePassResult = { ok: true, error: null, complete: true, imageless: 0, filled: 0, no_pack: 0, no_image: 0, fetch_errors: 0, write_errors: 0 }
const images = vi.fn<(opts: unknown) => Promise<DistImagePassResult>>(async () => IMAGES_CLEAN)
vi.mock("@/lib/packs/topshot-dist-images", () => ({ fillMissingDistImages: (opts: unknown) => images(opts) }))

// A chainable supabase stub: the read resolves `rows`; every update is captured
// and answers `updateResult` (an array of returned ids = rows that LANDED).
const sb = vi.hoisted(() => {
  const s: any = {
    rows: [] as any[], readError: null as any,
    updates: [] as any[], updateResult: { data: [{ id: "x" }], error: null } as any,
    rpcCalls: [] as any[], rpcResult: { data: 0, error: null } as any, readCalls: 0,
    checksResult: null as any,
  }
  // refresh_pack_supply_counter_checks answers `checksResult`; discovery answers `rpcResult`.
  s.rpc = (fn: string, args: any) => {
    s.rpcCalls.push({ fn, args, at: s.readCalls })
    return Promise.resolve(fn === "refresh_pack_supply_counter_checks" ? s.checksResult : s.rpcResult)
  }
  for (const m of ["from", "select", "eq", "is", "order"]) s[m] = () => s
  s.limit = () => (s.readCalls++, Promise.resolve(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null }))
  s.update = (patch: any) => { s.updates.push(patch); return s }
  // the update chain ends in .select("id") — return a thenable answering the update result
  const origSelect = s.select
  s.select = (cols?: string) => {
    if (cols === "id" && s.updates.length > s._selectSeen) { s._selectSeen = s.updates.length; return Promise.resolve(s.updateResult) }
    return origSelect(cols)
  }
  s._selectSeen = 0
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST, decodeDistInfo, mergeMetadata } from "@/app/api/cron/topshot-pack-dist-names-onchain/route"

// Flow REST answers `{ value: "<base64 of JSON-Cadence>" }`; the script returns {String:String}?.
function cadenceDict(entries: Record<string, string> | null) {
  if (entries === null) return { type: "Optional", value: null }
  return {
    type: "Optional",
    value: {
      type: "Dictionary",
      value: Object.entries(entries).map(([k, v]) => ({ key: { type: "String", value: k }, value: { type: "String", value: v } })),
    },
  }
}
function flowResult(entries: Record<string, string> | null) {
  return JSON.stringify({ value: Buffer.from(JSON.stringify(cadenceDict(entries)), "utf8").toString("base64") })
}
function stubFlow(answers: Array<Record<string, string> | null | "http500">) {
  let i = 0
  const f = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a === "http500") return { ok: false, status: 500, text: async () => '{"code":500,"message":"execution failed"}', json: async () => ({}) }
    return { ok: true, status: 200, json: async () => JSON.parse(flowResult(a)), text: async () => flowResult(a) }
  })
  vi.stubGlobal("fetch", f as any)
  return f
}

const CHECKS_CLEAN = { ok: true, rows_written: 3050, rows_deleted: 0, pd_refuted: 775, pev_refuted: 10, tier_refuted: 42 }
const NULL_META = { tier: null, uuid: null, pack_type: null, start_time: null, retail_price_usd: null, number_of_pack_slots: null }
const ROW_8825 = { id: "r1", dist_id: "8825", metadata: NULL_META }
const ROW_8869 = { id: "r2", dist_id: "8869", metadata: NULL_META }
const CHAIN_8825 = { title: "Portland Fire Seasonal Leaderboard Snapshot 2", state: "1", meta_tier: "rare", meta_numberOfPackSlots: "1", meta_description: "Awarded for placement on the Portland Fire seasonal leaderboard. Contains 1 Moment." }

const saved = { cron: process.env.CRON_SECRET, ingest: process.env.INGEST_SECRET_TOKEN }
beforeEach(() => {
  process.env.CRON_SECRET = "cron-tok"
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  captured = null
  sb.rows = []
  sb.readError = null
  sb.updates = []
  sb._selectSeen = 0
  sb.updateResult = { data: [{ id: "x" }], error: null }
  sb.rpcCalls = []
  sb.rpcResult = { data: 0, error: null }
  sb.checksResult = { data: CHECKS_CLEAN, error: null }
  sb.readCalls = 0
  heartbeat.mockClear()
  terminal.mockClear()
  images.mockReset()
  images.mockImplementation(async () => IMAGES_CLEAN)
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (saved.cron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved.cron
  if (saved.ingest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = saved.ingest
})

const req = (auth?: string) => makeReq({ url: "https://t/api/cron/topshot-pack-dist-names-onchain", auth })
const lastTerminal = () => terminal.mock.calls.at(-1)?.[0] as any

describe("authorisation — the dual-secret pattern, fail-closed", () => {
  it("accepts Bearer CRON_SECRET and Bearer INGEST_SECRET_TOKEN; 401s the rest, incl. a bare Bearer with secrets unset", async () => {
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    expect((await POST(req("Bearer ingest-tok"))).status).toBe(202)
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    delete process.env.CRON_SECRET
    delete process.env.INGEST_SECRET_TOKEN
    captured = null
    expect((await GET(req("Bearer "))).status).toBe(401)
    expect(captured).toBeNull()
  })
})

describe("decodeDistInfo", () => {
  it("reads title, tier (lowercased), slot count and description from the Cadence dictionary", () => {
    expect(decodeDistInfo(cadenceDict({ ...CHAIN_8825, meta_tier: "RARE" }))).toEqual({
      title: "Portland Fire Seasonal Leaderboard Snapshot 2", tier: "rare", numberOfPackSlots: 1,
      description: "Awarded for placement on the Portland Fire seasonal leaderboard. Contains 1 Moment.",
    })
  })
  it("strips the chain's HTML from the description (the column is read as text)", () => {
    const d = decodeDistInfo(cadenceDict({ title: "T", meta_description: "<p><span style=\"x\">The WNBA's first</span> <strong>tip-off</strong></p>\n<p>Two &amp; three.</p>" }))
    expect(d?.description).toBe("The WNBA's first tip-off Two & three.")
  })
  it("a nil Optional is NOT on chain (null), and an empty title is treated the same — never a fabricated name", () => {
    expect(decodeDistInfo(cadenceDict(null))).toBeNull()
    expect(decodeDistInfo(cadenceDict({ title: "   ", state: "1" }))).toBeNull()
  })
  it("a shape surprise throws (a failure, not an absence)", () => {
    expect(() => decodeDistInfo({ type: "Array", value: [] })).toThrow(/Optional/)
    expect(() => decodeDistInfo({ type: "Optional", value: { type: "String", value: "x" } })).toThrow(/Dictionary/)
  })
})

describe("mergeMetadata is fill-only", () => {
  it("fills NULL/absent keys and never overwrites a value another writer set", () => {
    const info = { title: "T", tier: "rare", numberOfPackSlots: 1, description: "d" }
    expect(mergeMetadata(NULL_META, info)).toMatchObject({ tier: "rare", number_of_pack_slots: 1, description: "d", uuid: null })
    expect(mergeMetadata({ tier: "common", number_of_pack_slots: 3 }, info)).toMatchObject({ tier: "common", number_of_pack_slots: 3, description: "d" })
    expect(mergeMetadata(null, { ...info, tier: null, numberOfPackSlots: null, description: null })).toEqual({})
  })
})

describe("the sweep", () => {
  it("heartbeat first, one PDS script per unnamed dist, a fill-only write keyed on title IS NULL, terminal row last with the LANDED count", async () => {
    sb.rows = [ROW_8825, ROW_8869]
    const f = stubFlow([CHAIN_8825, null]) // 8869: the chain does not know it
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    await captured!()

    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat.mock.invocationCallOrder[0]).toBeLessThan((f as any).mock.invocationCallOrder[0])
    expect(f).toHaveBeenCalledTimes(2)
    const body = JSON.parse((f as any).mock.calls[0][1].body)
    expect(JSON.parse(Buffer.from(body.arguments[0], "base64").toString("utf8"))).toEqual({ type: "UInt64", value: "8825" })
    expect((f as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)

    // Only the named dist is written; the write carries the title and the filled metadata.
    expect(sb.updates).toHaveLength(1)
    expect(sb.updates[0].title).toBe("Portland Fire Seasonal Leaderboard Snapshot 2")
    expect(sb.updates[0].metadata).toMatchObject({ tier: "rare", number_of_pack_slots: 1 })

    const t = lastTerminal()
    expect(t.pipeline).toBe("topshot-pack-dist-names-onchain")
    expect(t.ok).toBe(true)
    expect(t.rowsFound).toBe(2)
    expect(t.rowsWritten).toBe(1)
    expect(t.rowsSkipped).toBe(1)
    expect(t.extra).toMatchObject({ complete: true, unnamed: 2, named: 1, not_on_chain: 1, script_calls: 2, script_errors: 0, write_errors: 0 })
    expect(terminal.mock.invocationCallOrder[0]).toBeGreaterThan((f as any).mock.invocationCallOrder[1])
  })

  it("a Flow REST failure is a FAILED run (ok=false) that still names its error, never a quietly smaller sweep", async () => {
    sb.rows = [ROW_8825, ROW_8869]
    stubFlow(["http500", CHAIN_8825])
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/Flow REST HTTP 500/)
    expect(t.extra).toMatchObject({ script_errors: 1, named: 1 })
  })

  it("the written count is what the UPDATE returned — a write that landed nothing (a concurrent namer) counts 0", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    sb.updateResult = { data: [], error: null }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal().rowsWritten).toBe(0)
  })

  it("a write error fails the run", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    sb.updateResult = { data: null, error: { message: "permission denied" } }
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/permission denied/)
    expect(t.extra.write_errors).toBe(1)
  })

  it("a read failure is a failed run with nothing written and no script called", async () => {
    sb.readError = { message: "db down" }
    const f = stubFlow([CHAIN_8825])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(f).not.toHaveBeenCalled()
    expect(lastTerminal()).toMatchObject({ ok: false, rowsWritten: 0 })
  })

  it("DISCOVERS missing dists first (before the unnamed read), and counts what it inserted", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    sb.rpcResult = { data: 2, error: null }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(sb.rpcCalls.map((c: any) => c.fn)).toEqual(["discover_missing_topshot_pack_distributions", "refresh_pack_supply_counter_checks"])
    expect(sb.rpcCalls[0]).toMatchObject({ fn: "discover_missing_topshot_pack_distributions", args: { p_days: 7 }, at: 0 })
    const t = lastTerminal()
    expect(t).toMatchObject({ ok: true, rowsWritten: 3 })
    expect(t.extra.discovered).toBe(2)
  })

  it("a failed discovery fails the run, reports discovered=null (never 0), and still names what exists", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    sb.rpcResult = { data: null, error: { message: "statement timeout" } }
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/discover: statement timeout/)
    expect(t.extra.discovered).toBeNull()
    expect(sb.updates).toHaveLength(1)
    expect(t.rowsWritten).toBe(1)
  })

  it("a discovery that returns no count is a failure, not a zero", async () => {
    sb.rows = []
    stubFlow([])
    sb.rpcResult = { data: null, error: null }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal()).toMatchObject({ ok: false })
    expect(lastTerminal().extra.discovered).toBeNull()
  })

  it("runs the image pass after naming and folds its filled count into the written total", async () => {
    sb.rows = [ROW_8825]
    const f = stubFlow([CHAIN_8825])
    images.mockImplementation(async () => ({ ...IMAGES_CLEAN, imageless: 3, filled: 2, no_image: 1 }))
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(images).toHaveBeenCalledTimes(1)
    expect(images.mock.invocationCallOrder[0]).toBeGreaterThan((f as any).mock.invocationCallOrder[0])
    expect(images.mock.calls[0][0]).toMatchObject({ collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd" })
    const t = lastTerminal()
    expect(t).toMatchObject({ ok: true, rowsFound: 4, rowsWritten: 3 })
    expect(t.extra.images).toMatchObject({ filled: 2, no_image: 1 })
  })

  it("a failed image pass fails the run and names its error, even when naming succeeded", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    images.mockImplementation(async () => ({ ...IMAGES_CLEAN, ok: false, error: "pack media 1: HTTP 500 with no redirect", fetch_errors: 1 }))
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/pack media 1/)
    expect(t.rowsWritten).toBe(1)
  })

  it("an image pass that THROWS still fails the run and still writes the terminal row", async () => {
    sb.rows = []
    stubFlow([])
    images.mockImplementation(async () => { throw new Error("boom") })
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal()).toMatchObject({ ok: false })
    expect(String(lastTerminal().error)).toMatch(/images: boom/)
  })

  it("refreshes the counter checks LAST and reports their verdict counts in extra", async () => {
    sb.rows = [ROW_8825]
    stubFlow([CHAIN_8825])
    await GET(req("Bearer cron-tok"))
    await captured!()
    const last = sb.rpcCalls[sb.rpcCalls.length - 1]
    expect(last.fn).toBe("refresh_pack_supply_counter_checks")
    const t = lastTerminal()
    expect(t.ok).toBe(true)
    expect(t.extra.counter_checks).toEqual(CHECKS_CLEAN)
  })

  it("a failed or shapeless counter check fails the run and reports null, never a clean verdict", async () => {
    for (const checksResult of [
      { data: null, error: { message: "statement timeout" } },
      { data: null, error: null },
      { data: { ok: false }, error: null },
    ]) {
      terminal.mockClear()
      sb.rpcCalls = []
      sb.checksResult = checksResult
      sb.rows = []
      stubFlow([])
      await GET(req("Bearer cron-tok"))
      await captured!()
      const t = lastTerminal()
      expect(t.ok).toBe(false)
      expect(String(t.error)).toMatch(/counter checks/)
      expect(t.extra.counter_checks).toBeNull()
    }
  })

  it("nothing unnamed is a clean, complete, zero-row run", async () => {
    sb.rows = []
    const f = stubFlow([])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(f).not.toHaveBeenCalled()
    expect(lastTerminal()).toMatchObject({ ok: true, rowsFound: 0, rowsWritten: 0 })
    expect(lastTerminal().extra.complete).toBe(true)
  })
})
