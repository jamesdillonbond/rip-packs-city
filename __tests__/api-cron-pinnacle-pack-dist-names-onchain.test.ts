import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// /api/cron/pinnacle-pack-dist-names-onchain — discovers Pinnacle pack
// distributions the opens reference and pack_distributions lacks, then names
// every untitled Pinnacle row from the PDS contract, fill-only. Built 2026-10-19
// after the 10-09 drop (dist 8891, 414 opens) was found with no row because
// Studio's searchDistributions stopped listing new Pinnacle dists in August.

let captured: (() => Promise<void>) | null = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { captured = fn } }
})
const heartbeat = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/heartbeat", () => ({ writeInvocationHeartbeat: (opts: unknown) => heartbeat(opts) }))
const terminal = vi.fn<(opts: unknown) => Promise<boolean>>(async () => true)
vi.mock("@/lib/pipeline/terminal-run", () => ({ logTerminalRun: (opts: unknown) => terminal(opts) }))

const sb = vi.hoisted(() => {
  const s: any = {
    rows: [] as any[], readError: null as any, eqs: [] as any[],
    updates: [] as any[], updateResult: { data: [{ id: "x" }], error: null } as any,
    rpcCalls: [] as any[], rpcResult: { data: 0, error: null } as any, readCalls: 0,
  }
  s.rpc = (fn: string, args: any) => { s.rpcCalls.push({ fn, args, at: s.readCalls }); return Promise.resolve(s.rpcResult) }
  for (const m of ["from", "is", "order"]) s[m] = () => s
  s.eq = (col: string, val: unknown) => { s.eqs.push([col, val]); return s }
  s.limit = () => (s.readCalls++, Promise.resolve(s.readError ? { data: null, error: s.readError } : { data: s.rows, error: null }))
  s.update = (patch: any) => { s.updates.push(patch); return s }
  s._selectSeen = 0
  s.select = (cols?: string) => {
    if (cols === "id" && s.updates.length > s._selectSeen) { s._selectSeen = s.updates.length; return Promise.resolve(s.updateResult) }
    return s
  }
  return s
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))

import { GET, POST } from "@/app/api/cron/pinnacle-pack-dist-names-onchain/route"
import { decodePdsDistFacts, mergePinnacleDistMetadata } from "@/lib/packs/pds-dist-info"

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
function stubFlow(answers: Array<Record<string, string> | null | "http500">) {
  let i = 0
  const f = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]
    if (a === "http500") return { ok: false, status: 500, text: async () => '{"code":500}', json: async () => ({}) }
    const v = Buffer.from(JSON.stringify(cadenceDict(a)), "utf8").toString("base64")
    return { ok: true, status: 200, json: async () => ({ value: v }), text: async () => JSON.stringify({ value: v }) }
  })
  vi.stubGlobal("fetch", f as any)
  return f
}

// Verbatim shape of the 2026-10-19 mainnet answer for dist 8891.
const CHAIN_8891 = {
  title: "Star Wars Halloween Vol.1", state: "0", meta_endTime: "2027-10-16 16:00:00 +0000 UTC",
  meta_tier: "limited_edition", meta_numberOfPackSlots: "1", meta_name: "Star Wars Halloween Vol.1",
  meta_productID: "disney", meta_price: "49.95", meta_startTime: "2026-10-08 16:00:00 +0000 UTC",
  meta_distributionUUID: "a56ee674-5373-4f2b-8cb4-67c8854b5c2e", meta_packType: "pack",
}
const ROW_8891 = { id: "p1", dist_id: "8891", metadata: { seeded_from: "discovered_from_pinnacle_opens" } }
const ROW_9000 = { id: "p2", dist_id: "9000", metadata: null }

const saved = { cron: process.env.CRON_SECRET, ingest: process.env.INGEST_SECRET_TOKEN }
beforeEach(() => {
  process.env.CRON_SECRET = "cron-tok"
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  captured = null
  Object.assign(sb, { rows: [], readError: null, eqs: [], updates: [], _selectSeen: 0, rpcCalls: [], readCalls: 0 })
  sb.updateResult = { data: [{ id: "x" }], error: null }
  sb.rpcResult = { data: 0, error: null }
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

const req = (auth?: string) => makeReq({ url: "https://t/api/cron/pinnacle-pack-dist-names-onchain", auth })
const lastTerminal = () => terminal.mock.calls.at(-1)?.[0] as any

describe("decodePdsDistFacts", () => {
  it("reads title, product, tier, slots, price, uuid and sale window", () => {
    expect(decodePdsDistFacts(cadenceDict(CHAIN_8891))).toEqual({
      title: "Star Wars Halloween Vol.1", productId: "disney", tier: "limited_edition", numberOfPackSlots: 1,
      priceUsd: 49.95, uuid: "a56ee674-5373-4f2b-8cb4-67c8854b5c2e",
      startTime: "2026-10-08 16:00:00 +0000 UTC", endTime: "2027-10-16 16:00:00 +0000 UTC", description: null,
    })
  })
  it("0 slots is unknown, never 0; a non-numeric price is unknown", () => {
    const d = decodePdsDistFacts(cadenceDict({ title: "T", meta_numberOfPackSlots: "0", meta_price: "n/a" }))
    expect(d).toMatchObject({ numberOfPackSlots: null, priceUsd: null })
  })
  it("nil or a blank title is not on chain; a shape surprise throws", () => {
    expect(decodePdsDistFacts(cadenceDict(null))).toBeNull()
    expect(decodePdsDistFacts(cadenceDict({ title: "  " }))).toBeNull()
    expect(() => decodePdsDistFacts({ type: "Array", value: [] })).toThrow(/Optional/)
  })
})

describe("mergePinnacleDistMetadata is fill-only", () => {
  const facts = decodePdsDistFacts(cadenceDict(CHAIN_8891))!
  it("fills absent keys in the Pinnacle row shape (retail_price_usd in dollars)", () => {
    expect(mergePinnacleDistMetadata({ seeded_from: "x" }, facts)).toMatchObject({
      seeded_from: "x", tier: "limited_edition", number_of_pack_slots: 1, retail_price_usd: 49.95,
      uuid: "a56ee674-5373-4f2b-8cb4-67c8854b5c2e", source: "pds_contract",
    })
  })
  it("never overwrites a value another writer set", () => {
    const out = mergePinnacleDistMetadata({ retail_price_usd: 39.99, number_of_pack_slots: 3, source: "studio_platform_gql" }, facts)
    expect(out).toMatchObject({ retail_price_usd: 39.99, number_of_pack_slots: 3, source: "studio_platform_gql" })
  })
})

describe("the sweep", () => {
  it("401s without a secret", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await POST(req("Bearer nope"))).status).toBe(401)
    expect(captured).toBeNull()
  })

  it("discovers first, reads ONLY Pinnacle rows, names from PDS fill-only, and counts what landed", async () => {
    sb.rows = [ROW_8891]
    sb.rpcResult = { data: 1, error: null }
    const f = stubFlow([CHAIN_8891])
    expect((await GET(req("Bearer cron-tok"))).status).toBe(202)
    await captured!()

    expect(heartbeat.mock.invocationCallOrder[0]).toBeLessThan((f as any).mock.invocationCallOrder[0])
    expect(sb.rpcCalls).toEqual([{ fn: "discover_missing_pinnacle_pack_distributions", args: { p_days: 14 }, at: 0 }])
    expect(sb.eqs).toContainEqual(["collection_id", "7dd9dd11-e8b6-45c4-ac99-71331f959714"])
    expect(sb.updates).toHaveLength(1)
    expect(sb.updates[0].title).toBe("Star Wars Halloween Vol.1")
    expect(sb.updates[0].metadata).toMatchObject({ retail_price_usd: 49.95, number_of_pack_slots: 1, seeded_from: "discovered_from_pinnacle_opens" })

    const t = lastTerminal()
    expect(t).toMatchObject({ pipeline: "pinnacle-pack-dist-names-onchain", ok: true, rowsFound: 1, rowsWritten: 2, rowsSkipped: 0, collectionSlug: "disney-pinnacle" })
    expect(t.extra).toMatchObject({ complete: true, discovered: 1, untitled: 1, named: 1, not_on_chain: 0, wrong_product: 0 })
  })

  it("a dist PDS lists under another product is NOT named (it is not a Pinnacle distribution)", async () => {
    sb.rows = [ROW_9000]
    stubFlow([{ ...CHAIN_8891, meta_productID: "nba", title: "Some Top Shot Pack" }])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(sb.updates).toHaveLength(0)
    expect(lastTerminal()).toMatchObject({ ok: true, rowsSkipped: 1 })
    expect(lastTerminal().extra.wrong_product).toBe(1)
  })

  it("a dist the chain does not know stays untitled and is counted", async () => {
    sb.rows = [ROW_9000]
    stubFlow([null])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(sb.updates).toHaveLength(0)
    expect(lastTerminal().extra.not_on_chain).toBe(1)
  })

  it("a Flow REST failure fails the run and still names the next row", async () => {
    sb.rows = [ROW_9000, ROW_8891]
    stubFlow(["http500", CHAIN_8891])
    await GET(req("Bearer cron-tok"))
    await captured!()
    const t = lastTerminal()
    expect(t.ok).toBe(false)
    expect(String(t.error)).toMatch(/Flow REST HTTP 500/)
    expect(t.extra).toMatchObject({ script_errors: 1, named: 1 })
  })

  it("a write that landed nothing counts 0; a write error fails the run", async () => {
    sb.rows = [ROW_8891]
    stubFlow([CHAIN_8891])
    sb.updateResult = { data: [], error: null }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal()).toMatchObject({ ok: true, rowsWritten: 0 })

    terminal.mockClear()
    Object.assign(sb, { updates: [], _selectSeen: 0 })
    sb.updateResult = { data: null, error: { message: "permission denied" } }
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(lastTerminal().ok).toBe(false)
    expect(lastTerminal().extra.write_errors).toBe(1)
  })

  it("a failed or countless discovery fails the run with discovered=null (never 0), and naming still runs", async () => {
    for (const rpcResult of [{ data: null, error: { message: "statement timeout" } }, { data: null, error: null }]) {
      terminal.mockClear()
      Object.assign(sb, { rows: [ROW_8891], updates: [], _selectSeen: 0, rpcCalls: [] })
      sb.rpcResult = rpcResult
      stubFlow([CHAIN_8891])
      await GET(req("Bearer cron-tok"))
      await captured!()
      const t = lastTerminal()
      expect(t.ok).toBe(false)
      expect(String(t.error)).toMatch(/discover:/)
      expect(t.extra.discovered).toBeNull()
      expect(sb.updates).toHaveLength(1)
    }
  })

  it("a read failure fails the run with nothing written and no script called", async () => {
    sb.readError = { message: "db down" }
    const f = stubFlow([CHAIN_8891])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(f).not.toHaveBeenCalled()
    expect(lastTerminal()).toMatchObject({ ok: false, rowsWritten: 0 })
  })

  it("nothing untitled is a clean, complete, zero-row run", async () => {
    const f = stubFlow([])
    await GET(req("Bearer cron-tok"))
    await captured!()
    expect(f).not.toHaveBeenCalled()
    expect(lastTerminal()).toMatchObject({ ok: true, rowsFound: 0, rowsWritten: 0 })
  })
})
