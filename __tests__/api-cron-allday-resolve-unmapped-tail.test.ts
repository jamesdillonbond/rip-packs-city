import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-drive of /api/cron/allday-resolve-unmapped-tail (added 2026-07-25) — the
// SYNCHRONOUS on-chain resolver for the OLD (>7d) edition-unknown residue the
// live resolver skips. Stubs only the Flow seam (runAllDayScript / scan /
// tx-buyers / decodeV1SaleTx); normalizeAddress + buildOnChainEditionRow stay
// REAL. Pins: buyer-borrow resolve + resolve-RPC contract; current-holder scan
// fallback + on-chain edition hydration; benign nil vs degraded (>=10 attempts,
// all-error, 0 promoted -> ok=false); fatal load accounting; dual-auth 401.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  borrowByKey: {} as Record<string, Record<string, string> | "throw" | null>,
  borrowDefault: null as Record<string, string> | "throw" | null,
  editionDataById: {} as Record<string, Record<string, string> | null>,
  scriptCalls: [] as Array<{ kind: "borrow" | "edition"; args: Array<{ type: string; value: unknown }> }>,
  scanCalls: [] as Array<{ nftId: string; start: number; window: number }>,
  scanChunkCount: 0,
  scanRecipients: [] as Array<{ block: number; to: string }>,
  decodeBuyerByTx: {} as Record<string, string | null>,
  txBuyers: [] as string[],
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, p) => (state.sb as Record<PropertyKey, unknown>)[p] }),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string) => ({
    buyer: state.decodeBuyerByTx[tx] ?? null,
    seller: null,
    priceDuc: null,
    priceCertain: false,
    priceReason: "no_duc_from_contract",
    sampleAmounts: [],
  }),
}))
vi.mock("@/lib/chains/flow/allday-edition-onchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chains/flow/allday-edition-onchain")>()
  return {
    ...actual,
    runAllDayScript: async (code: string, args: Array<{ type: string; value: unknown }>) => {
      const kind = code.includes("borrowMomentNFT") ? ("borrow" as const) : ("edition" as const)
      state.scriptCalls.push({ kind, args })
      if (kind === "borrow") {
        const key = `${args[0].value}|${args[1].value}`
        const r = key in state.borrowByKey ? state.borrowByKey[key] : state.borrowDefault
        if (r === "throw") throw new Error("script HTTP 500")
        return r
      }
      return state.editionDataById[String(args[0].value)] ?? null
    },
    scanAllDayDepositsForNft: async (nftId: string, start: number, window: number, onChunk?: () => void) => {
      state.scanCalls.push({ nftId, start, window })
      for (let i = 0; i < state.scanChunkCount; i++) onChunk?.()
      return state.scanRecipients
    },
    fetchTxBuyers: async () => state.txBuyers,
  }
})

process.env.INGEST_SECRET_TOKEN = "tail-token"
process.env.CRON_SECRET = "cron-token"

const { POST, GET } = await import("@/app/api/cron/allday-resolve-unmapped-tail/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
function req(auth: string | null = "Bearer tail-token", method: "POST" | "GET" = "POST"): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/cron/allday-resolve-unmapped-tail", { method, headers })
}
const oldIso = () => new Date(Date.now() - 30 * 86_400_000).toISOString()
function openRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    nft_id: "606",
    transaction_hash: "0x" + "b".repeat(64),
    buyer_address: null,
    serial_number: null,
    block_height: 5000,
    sold_at: oldIso(),
    ...over,
  }
}
function tailLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "allday-unmapped-resolver-tail").at(-1)?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tail-token"
  process.env.CRON_SECRET = "cron-token"
  state.borrowByKey = {}
  state.borrowDefault = null
  state.editionDataById = {}
  state.scriptCalls = []
  state.scanCalls = []
  state.scanChunkCount = 0
  state.scanRecipients = []
  state.decodeBuyerByTx = {}
  state.txBuyers = []
})

describe("allday-resolve-unmapped-tail — resolve paths", () => {
  it("borrows from the stored buyer, dedups multi-sale nfts, and hands the mapping to the resolve RPC", async () => {
    state.borrowByKey["0x0000000000000001|606"] = { id: "606", editionID: "901", serialNumber: "7", mintingDate: "1700000000.0" }
    const spy = install({
      unmapped_sales: { data: [openRow({ buyer_address: "0x1" }), openRow({ buyer_address: "0x1" })], error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [{ external_id: "901" }], error: null },
      "rpc:resolve_unmapped_sales_for_collection": { data: { mapping_upserted: 1, promote_result: { promoted: 2, still_unresolved: 3 } }, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.pipeline).toBe("allday-unmapped-resolver-tail")

    const resolve = spy.rpcCalls.find((c) => c.name === "resolve_unmapped_sales_for_collection")
    expect(resolve?.args).toEqual({
      p_collection_id: ALLDAY,
      p_rows: [{ nft_id: "606", edition_external_id: "901", serial_number: 7 }],
      p_promote_limit: 1000,
    })
    expect(tailLog(spy.rpcCalls)).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 3, p_collection_slug: "nfl_all_day" })
    expect(tailLog(spy.rpcCalls)?.p_extra).toMatchObject({ onchain_resolved: 1, resolved_via_buyer: 1, resolved_via_scan: 0, promoted: 2 })
  })

  it("falls back to the current-holder Deposit scan (3000-block window) and hydrates the missing edition", async () => {
    state.borrowByKey["0x0000000000000002|707"] = null
    state.borrowByKey["0x00000000000000ab|707"] = { id: "707", editionID: "901", serialNumber: "9", mintingDate: "1.0" }
    state.scanChunkCount = 2
    state.scanRecipients = [
      { block: 5100, to: "0x0000000000000002" },
      { block: 5200, to: "0x00000000000000ab" },
    ]
    state.editionDataById["901"] = { playID: "10", setID: "20", tier: "RARE", maxMintSize: "100", numMinted: "50", playerName: "Josh Allen", setName: "Base Set" }
    const spy = install({
      unmapped_sales: { data: [openRow({ nft_id: "707", buyer_address: "0x2", block_height: 5000 })], error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": { data: { mapping_upserted: 1, promote_result: { promoted: 1, still_unresolved: 0 } }, error: null },
    })

    await POST(req())
    expect(state.scanCalls).toEqual([{ nftId: "707", start: 5000, window: 3000 }])
    const edUpsert = (spy.writes.editions ?? []).find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({ external_id: "901", name: "Josh Allen — Base Set", tier: "RARE", circulation_count: 100 })
    expect(tailLog(spy.rpcCalls)?.p_extra).toMatchObject({ resolved_via_scan: 1, scan_chunks: 2, editions_hydrated: 1 })
  })
})

describe("allday-resolve-unmapped-tail — degradation + auth", () => {
  it("benign nil misses do NOT flag degraded", async () => {
    state.borrowDefault = null
    state.txBuyers = ["0x00000000000000bb"]
    const rows = Array.from({ length: 3 }, (_, i) => openRow({ nft_id: `n${i}`, transaction_hash: "0x" + String(i).repeat(64).slice(0, 64) }))
    const spy = install({
      unmapped_sales: { data: rows, error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": { data: { mapping_upserted: 0, promote_result: { promoted: 0, still_unresolved: 3 } }, error: null },
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(tailLog(spy.rpcCalls)?.p_ok).toBe(true)
    expect(tailLog(spy.rpcCalls)?.p_extra).toMatchObject({ onchain_nil: 3, onchain_err: 0 })
  }, 15_000)

  it("flags degraded (ok=false, 500) when >=10 attempts all error and nothing promotes", async () => {
    state.borrowDefault = "throw"
    state.txBuyers = ["0x00000000000000bb"]
    const rows = Array.from({ length: 12 }, (_, i) => openRow({ nft_id: `d${i}`, transaction_hash: "0x" + String(i % 10).repeat(64).slice(0, 64) }))
    const spy = install({
      unmapped_sales: { data: rows, error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": { data: { mapping_upserted: 0, promote_result: { promoted: 0, still_unresolved: 12 } }, error: null },
    })
    const res = await POST(req())
    expect(res.status).toBe(500)
    const log = tailLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(log?.p_extra).toMatchObject({ onchain_resolved: 0, degraded: true })
  }, 20_000)

  it("a load_open failure logs ok=false and never calls the resolve RPC", async () => {
    const spy = install({ unmapped_sales: { data: null, error: { message: "permission denied" } } })
    await POST(req())
    const log = tailLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("load_open:permission denied")
    expect(spy.rpcCalls.some((c) => c.name === "resolve_unmapped_sales_for_collection")).toBe(false)
  })

  it("401s without a valid token and accepts CRON on GET", async () => {
    install({ unmapped_sales: { data: [], error: null }, "rpc:resolve_unmapped_sales_for_collection": { data: { mapping_upserted: 0, promote_result: { promoted: 0 } }, error: null } })
    expect((await POST(req(null))).status).toBe(401)
    expect((await GET(req("Bearer cron-token", "GET"))).status).toBe(200)
  })
})
