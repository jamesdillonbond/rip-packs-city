import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/cron/topshot-circulation-onchain — the
// on-chain replacement for the circulation half of the dead GraphQL catalog
// walker. The after() body is captured and run by hand so the whole sweep is
// observable: heartbeat first, one Flow REST script per 250 pairs, the apply
// RPC with the sentinel and the parallels filtered out, a terminal row last.

let captured: (() => Promise<void>) | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { captured = fn } }
})

const heartbeat = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: (opts: unknown) => heartbeat(opts) }))
const terminal = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/terminal-run", () => ({ logTerminalRun: (opts: unknown) => terminal(opts) }))

// A chainable supabase stub: the editions read resolves `pages` in order; rpc is captured.
const sb = vi.hoisted(() => {
  const s: any = { pages: [] as any[][], readError: null as any, rpcCalls: [] as any[], rpcResult: { data: { rows: 0, changed: 0 }, error: null } }
  for (const m of ["from", "select", "eq", "not", "order"]) s[m] = () => s
  s.range = () => {
    const page = s.pages.length ? s.pages.shift() : []
    return Promise.resolve(s.readError ? { data: null, error: s.readError } : { data: page, error: null })
  }
  s.rpc = async (name: string, args: any) => {
    s.rpcCalls.push({ name, args })
    return s.rpcResult
  }
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST, NOT_ON_CHAIN, decodeCountArray } from "@/app/api/cron/topshot-circulation-onchain/route"

// Flow REST answers `{ value: "<base64 of JSON-Cadence>" }`; the script returns [UInt32].
function flowResult(nums: number[]) {
  const cadence = { type: "Array", value: nums.map((n) => ({ type: "UInt32", value: String(n) })) }
  return JSON.stringify({ value: Buffer.from(JSON.stringify(cadence), "utf8").toString("base64") })
}
function stubFlow(nums: number[] | null, ok = true) {
  const f = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => JSON.parse(flowResult(nums ?? [])),
    text: async () => (ok ? flowResult(nums ?? []) : '{ "code": 503, "message": "execution node unavailable" }'),
  }))
  vi.stubGlobal("fetch", f as any)
  return f
}

const BASE_A = { id: "a", set_id_onchain: 250, play_id_onchain: 8810, external_id: "250:8810" }
const BASE_B = { id: "b", set_id_onchain: 274, play_id_onchain: 9076, external_id: "274:9076" }
const GHOST = { id: "g", set_id_onchain: 1, play_id_onchain: 999999, external_id: "1:999999" }
const PARALLEL = { id: "p", set_id_onchain: 250, play_id_onchain: 8810, external_id: "250:8810::18" }

const saved = { cron: process.env.CRON_SECRET, ingest: process.env.INGEST_SECRET_TOKEN }
beforeEach(() => {
  process.env.CRON_SECRET = "cron-tok"
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  captured = null
  sb.pages = []
  sb.readError = null
  sb.rpcCalls = []
  sb.rpcResult = { data: { rows: 0, changed: 0 }, error: null }
  heartbeat.mockClear()
  terminal.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (saved.cron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved.cron
  if (saved.ingest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = saved.ingest
})

const req = (auth?: string) => makeReq({ url: "https://t/api/cron/topshot-circulation-onchain", auth })

describe("authorisation — the dual-secret pattern, fail-closed", () => {
  it("accepts Bearer CRON_SECRET (what Vercel cron sends) and Bearer INGEST_SECRET_TOKEN", async () => {
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    expect((await POST(req("Bearer ingest-tok"))).status).toBe(202)
  })
  it("401s a missing or wrong bearer, and an UNSET secret never admits a bare `Bearer `", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req("Bearer nope"))).status).toBe(401)
    delete process.env.CRON_SECRET
    delete process.env.INGEST_SECRET_TOKEN
    expect((await GET(req("Bearer "))).status).toBe(401)
    expect(captured).toBeNull()
  })
})

describe("the sweep", () => {
  it("heartbeat first, one script per chunk, the sentinel and parallels never reach the RPC, terminal row last", async () => {
    // GHOST comes back as the sentinel; PARALLEL is excluded by the base-key test before any read.
    sb.pages = [[BASE_A, PARALLEL, GHOST, BASE_B]]
    // three pairs → [n, retired] × 3: A=1149 unretired, GHOST=sentinel, B=339 retired
    const f = stubFlow([1149, 0, NOT_ON_CHAIN, 2, 339, 1])
    sb.rpcResult = { data: { rows: 2, changed: 1 }, error: null }

    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    expect(captured).not.toBeNull()
    await captured!()

    expect(heartbeat).toHaveBeenCalledTimes(1)
    expect(heartbeat.mock.invocationCallOrder[0]).toBeLessThan((f as any).mock.invocationCallOrder[0])
    expect(f).toHaveBeenCalledTimes(1)
    // the script was asked about the three BASE pairs, in order, as UInt32 strings
    const body = JSON.parse((f as any).mock.calls[0][1].body)
    const setArg = JSON.parse(Buffer.from(body.arguments[0], "base64").toString("utf8"))
    expect(setArg.value.map((v: any) => v.value)).toEqual(["250", "1", "274"])
    expect((f as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)

    expect(sb.rpcCalls).toHaveLength(1)
    expect(sb.rpcCalls[0].name).toBe("apply_topshot_onchain_circulation")
    expect(sb.rpcCalls[0].args.p_rows).toEqual([{ id: "a", n: 1149 }, { id: "b", n: 339 }])

    expect(terminal).toHaveBeenCalledTimes(1)
    const t = (terminal as any).mock.calls[0][0]
    expect(t.pipeline).toBe("topshot-circulation-onchain")
    expect(t.ok).toBe(true)
    expect(t.rowsFound).toBe(3)
    expect(t.rowsWritten).toBe(1)
    expect(t.rowsSkipped).toBe(1)
    expect(t.extra).toMatchObject({ complete: true, not_on_chain: 1, retired: 1, sent_to_rpc: 2, changed: 1, script_calls: 1, script_errors: 0, rpc_errors: 0 })
  })

  it("a Flow REST failure is a FAILED run with the error named — nothing is written", async () => {
    sb.pages = [[BASE_A, BASE_B]]
    stubFlow(null, false)
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(sb.rpcCalls).toHaveLength(0)
    const t = (terminal as any).mock.calls[0][0]
    expect(t.ok).toBe(false)
    expect(t.error).toMatch(/flow rest: Flow REST HTTP 503/)
    expect(t.extra.script_errors).toBe(1)
  })

  it("an RPC error is a FAILED run, not a quietly smaller write count", async () => {
    sb.pages = [[BASE_A]]
    stubFlow([1149, 0])
    sb.rpcResult = { data: null, error: { message: "canceling statement due to statement timeout" } }
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = (terminal as any).mock.calls[0][0]
    expect(t.ok).toBe(false)
    expect(t.error).toMatch(/apply rpc: canceling statement/)
    expect(t.rowsWritten).toBe(0)
  })

  it("a failed editions read is a FAILED run — never a partial population read as complete", async () => {
    sb.readError = { message: "upstream request timeout" }
    const f = stubFlow([])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(f).not.toHaveBeenCalled()
    const t = (terminal as any).mock.calls[0][0]
    expect(t.ok).toBe(false)
    expect(t.error).toMatch(/editions read failed at offset 0/)
    expect(heartbeat).toHaveBeenCalledTimes(1)
  })

  it("a populated page followed by a short page is read in full and in one order", async () => {
    // page 1 is exactly READ_PAGE long only in production; here the short page ends the walk
    sb.pages = [[BASE_A], []]
    stubFlow([1149, 0])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(sb.rpcCalls[0].args.p_rows).toEqual([{ id: "a", n: 1149 }])
  })
})

describe("decodeCountArray refuses a surprising shape", () => {
  it("throws on a non-array, a non-numeric element, or a length that does not match the pairs", () => {
    expect(() => decodeCountArray({ type: "Dictionary", value: [] }, 1)).toThrow(/not a JSON-Cadence Array/)
    expect(() => decodeCountArray({ type: "Array", value: [{ type: "UInt32", value: "x" }, { type: "UInt32", value: "0" }] }, 1)).toThrow(/non-numeric/)
    expect(() => decodeCountArray({ type: "Array", value: [{ type: "UInt32", value: "5" }] }, 1)).toThrow(/returned 1 values for 1 pairs/)
    expect(decodeCountArray({ type: "Array", value: [{ type: "UInt32", value: "5" }, { type: "UInt32", value: "1" }] }, 1)).toEqual([5, 1])
  })
})
