import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of POST /api/cron/allday-resolve-unmapped — the WAF-proof on-chain
// resolver that replaced the GQL edge fn. Captures after() and stubs only the
// Flow network seam (runAllDayScript / scan / tx-buyers / decodeV1SaleTx);
// normalizeAddress + buildOnChainEditionRow stay REAL so edition hydration rows
// are handler-computed. Pins:
//   - Leg B buyer-borrow: mapping row + resolve RPC contract + honest counters;
//   - the current-holder Deposit-scan fallback (newest-first, skips tried
//     buyers, scan_chunks accounting) + on-chain edition hydration;
//   - the SCAN_MAX_AGE_DAYS gate (old rows never burn scan budget) while
//     Leg A promote still runs on every tick — the exact bug the old edge fn had;
//   - the degraded tripwire (all-error, 0 promoted -> ok=false) vs benign nil;
//   - fatal load/resolve error accounting and the 202-accept surface.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  borrowByKey: {} as Record<string, Record<string, string> | "throw" | null>,
  borrowDefault: null as Record<string, string> | "throw" | null,
  editionDataById: {} as Record<string, Record<string, string> | null>,
  scriptCalls: [] as Array<{ kind: "borrow" | "edition"; args: Array<{ type: string; value: unknown }> }>,
  scanCalls: [] as Array<{ nftId: string; start: number; window: number }>,
  scanChunkCount: 0,
  scanRecipients: [] as Array<{ block: number; to: string }>,
  decodeCalls: [] as Array<{ tx: string; nftId: string }>,
  decodeBuyerByTx: {} as Record<string, string | null>,
  txBuyersCalls: [] as string[],
  txBuyers: [] as string[],
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
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string, opts: { nftId: string }) => {
    state.decodeCalls.push({ tx, nftId: opts.nftId })
    return {
      buyer: state.decodeBuyerByTx[tx] ?? null,
      seller: null,
      priceDuc: null,
      priceCertain: false,
      priceReason: "no_duc_transfer",
      sampleAmounts: [],
    }
  },
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
    scanAllDayDepositsForNft: async (
      nftId: string,
      start: number,
      window: number,
      onChunk?: () => void,
    ) => {
      state.scanCalls.push({ nftId, start, window })
      for (let i = 0; i < state.scanChunkCount; i++) onChunk?.()
      return state.scanRecipients
    },
    fetchTxBuyers: async (tx: string) => {
      state.txBuyersCalls.push(tx)
      return state.txBuyers
    },
  }
})

// TOKEN is read into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "resolver-token"

const { POST } = await import("@/app/api/cron/allday-resolve-unmapped/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(auth: string | null = "Bearer resolver-token"): NextRequest {
  const headers = new Headers()
  if (auth !== null) headers.set("authorization", auth)
  return new NextRequest("https://t/api/cron/allday-resolve-unmapped", { method: "POST", headers })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function openRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    nft_id: "606",
    transaction_hash: "0x" + "b".repeat(64),
    buyer_address: null,
    serial_number: null,
    block_height: 5000,
    sold_at: new Date().toISOString(),
    price_usd: 12.5,
    ...over,
  }
}

function resolverLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "allday-unmapped-resolver")
    .at(-1)?.args
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "resolver-token"
  state.afterCbs.length = 0
  state.borrowByKey = {}
  state.borrowDefault = null
  state.editionDataById = {}
  state.scriptCalls = []
  state.scanCalls = []
  state.scanChunkCount = 0
  state.scanRecipients = []
  state.decodeCalls = []
  state.decodeBuyerByTx = {}
  state.txBuyersCalls = []
  state.txBuyers = []
})

describe("allday-resolve-unmapped — Leg B buyer-borrow", () => {
  it("borrows from the stored buyer, dedups multi-sale nfts, and hands the mapping to the resolve RPC", async () => {
    // Two open sale rows for the SAME nft — one mapping promotes both.
    state.borrowByKey["0x0000000000000001|606"] = {
      id: "606",
      editionID: "901",
      serialNumber: "7",
      mintingDate: "1700000000.0",
    }
    const spy = install({
      unmapped_sales: {
        data: [openRow({ buyer_address: "0x1" }), openRow({ buyer_address: "0x1" })],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [{ external_id: "901" }], error: null }, // already cataloged -> no hydrate
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 1, promote_result: { promoted: 2, still_unresolved: 3 } },
        error: null,
      },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.status).toBe("accepted")
    expect(body.collection_id).toBe(ALLDAY)
    await runDeferred()

    // The borrow used the NORMALIZED buyer address (0x1 -> zero-padded 16 hex).
    expect(state.scriptCalls).toEqual([
      {
        kind: "borrow",
        args: [
          { type: "Address", value: "0x0000000000000001" },
          { type: "UInt64", value: "606" },
        ],
      },
    ])

    // The resolve RPC got the exact computed mapping row + the promote limit.
    const resolve = spy.rpcCalls.find((c) => c.name === "resolve_unmapped_sales_for_collection")
    expect(resolve?.args).toEqual({
      p_collection_id: ALLDAY,
      p_rows: [{ nft_id: "606", edition_external_id: "901", serial_number: 7 }],
      p_promote_limit: 1000,
    })

    const log = resolverLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1, // deduped by nft_id
      p_rows_written: 3, // mappings(1) + promoted(2)
      p_collection_slug: "nfl-all-day",
    })
    expect(log?.p_extra).toMatchObject({
      candidates: 1,
      needing_onchain: 1,
      onchain_attempted: 1,
      onchain_resolved: 1,
      resolved_via_buyer: 1,
      resolved_via_scan: 0,
      onchain_nil: 0,
      onchain_err: 0,
      mappings_written: 1,
      promoted: 2,
      still_unresolved: 3,
      editions_hydrated: 0,
    })
  })

  it("falls back to the forward Deposit scan (newest-first, skipping tried buyers) and hydrates the missing edition on-chain", async () => {
    // Buyer borrow returns nil (Dapper intermediate already re-deposited).
    state.borrowByKey["0x0000000000000002|707"] = null
    state.borrowByKey["0x00000000000000ab|707"] = {
      id: "707",
      editionID: "901",
      serialNumber: "9",
      mintingDate: "1700000001.0",
    }
    state.scanChunkCount = 3
    state.scanRecipients = [
      { block: 5100, to: "0x0000000000000002" }, // the already-tried buyer deposit
      { block: 5200, to: "0x00000000000000ab" }, // the real end-user holder
    ]
    state.editionDataById["901"] = {
      playID: "10",
      setID: "20",
      tier: "RARE",
      maxMintSize: "100",
      numMinted: "50",
      playerName: "Josh Allen",
      teamName: "Buffalo Bills",
      setName: "Base Set",
      seriesID: "3",
      playType: "Pass",
      dateOfMoment: "2026-01-15T00:00:00Z",
      homeTeamName: "Buffalo Bills",
      awayTeamName: "Miami Dolphins",
    }
    const spy = install({
      unmapped_sales: {
        data: [openRow({ nft_id: "707", buyer_address: "0x2", block_height: 5000 })],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null }, // NOT cataloged -> hydrate path
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 1, promote_result: { promoted: 1, still_unresolved: 0 } },
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    // Scan was window-parameterized from the sale block; chunk budget observed.
    expect(state.scanCalls).toEqual([{ nftId: "707", start: 5000, window: 2000 }])

    // Borrow order: buyer fast-path, then ONLY the untried newest recipient.
    const borrows = state.scriptCalls.filter((c) => c.kind === "borrow")
    expect(borrows.map((c) => c.args[0].value)).toEqual(["0x0000000000000002", "0x00000000000000ab"])

    // Edition hydration: GET_EDITION_DATA ran and the REAL buildOnChainEditionRow
    // output was upserted (handler-computed, not fixture echo).
    expect(state.scriptCalls.filter((c) => c.kind === "edition").map((c) => c.args[0].value)).toEqual(["901"])
    const edUpsert = (spy.writes.editions ?? []).find((w) => w.method === "upsert")
    expect(edUpsert?.rows).toHaveLength(1)
    expect(edUpsert?.rows[0]).toMatchObject({
      external_id: "901",
      collection_id: ALLDAY,
      collection: "nfl_all_day",
      name: "Josh Allen — Base Set",
      player_name: "Josh Allen",
      set_name: "Base Set",
      team_name: "Buffalo Bills",
      tier: "RARE",
      series: 3,
      circulation_count: 100, // maxMintSize wins over numMinted
      set_id_onchain: 20,
      play_id_onchain: 10,
      play_type: "Pass",
      game_date: "2026-01-15",
      home_team: "Buffalo Bills",
      away_team: "Miami Dolphins",
    })

    const resolve = spy.rpcCalls.find((c) => c.name === "resolve_unmapped_sales_for_collection")
    expect(resolve?.args?.p_rows).toEqual([
      { nft_id: "707", edition_external_id: "901", serial_number: 9 },
    ])

    const log = resolverLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect(log?.p_extra).toMatchObject({
      onchain_resolved: 1,
      resolved_via_scan: 1,
      resolved_via_buyer: 0,
      scan_chunks: 3,
      editions_hydrated: 1,
    })
  })
})

describe("allday-resolve-unmapped — budget gates + degradation", () => {
  it("old backlog rows skip the scan (age gate) as benign nil, but Leg A promote still drains every tick", async () => {
    // 30-day-old sale — buyer borrow nil, scan must NOT fire.
    const oldIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const spy = install({
      unmapped_sales: {
        data: [openRow({ nft_id: "808", buyer_address: "0x3", sold_at: oldIso })],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 0, promote_result: { promoted: 4, still_unresolved: 6 } },
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    expect(state.scanCalls).toHaveLength(0)
    // Promote ran with an EMPTY mapping set — the always-run-Leg-A fix.
    const resolve = spy.rpcCalls.find((c) => c.name === "resolve_unmapped_sales_for_collection")
    expect(resolve?.args?.p_rows).toEqual([])

    const log = resolverLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 4, p_rows_skipped: 0 })
    expect(log?.p_extra).toMatchObject({ onchain_nil: 1, onchain_err: 0, promoted: 4 })
    expect((log?.p_extra as Record<string, unknown>).degraded).toBeUndefined()
  })

  it("flags degraded (ok=false) when every on-chain attempt errors and nothing promotes", async () => {
    state.borrowDefault = "throw"
    state.txBuyers = ["0x00000000000000bb"]
    const oldIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const rows = Array.from({ length: 5 }, (_, i) =>
      openRow({ nft_id: `d${i}`, transaction_hash: "0x" + String(i).repeat(64).slice(0, 64), sold_at: oldIso }),
    )
    const spy = install({
      unmapped_sales: { data: rows, error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 0, promote_result: { promoted: 0, still_unresolved: 5 } },
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    // Buyer recovery chain ran per row: decode -> tx-envelope candidates.
    expect(state.decodeCalls).toHaveLength(5)
    expect(state.txBuyersCalls).toHaveLength(5)

    const log = resolverLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(log?.p_error).toBe("degraded: onchain resolution failing, 0 promoted")
    expect(log?.p_extra).toMatchObject({
      onchain_attempted: 5,
      onchain_err: 5,
      onchain_resolved: 0,
      promoted: 0,
      degraded: true,
    })
  }, 15_000)

  it("benign nil misses do NOT flag degraded even at zero promoted", async () => {
    // Same shape but borrows return nil (buyer moved on) instead of erroring.
    state.borrowDefault = null
    state.txBuyers = ["0x00000000000000bb"]
    const oldIso = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const rows = Array.from({ length: 5 }, (_, i) =>
      openRow({ nft_id: `n${i}`, transaction_hash: "0x" + String(i).repeat(64).slice(0, 64), sold_at: oldIso }),
    )
    const spy = install({
      unmapped_sales: { data: rows, error: null },
      nft_edition_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": {
        data: { mapping_upserted: 0, promote_result: { promoted: 0, still_unresolved: 5 } },
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    const log = resolverLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(true)
    expect(log?.p_extra).toMatchObject({ onchain_nil: 5, onchain_err: 0 })
  }, 15_000)
})

describe("allday-resolve-unmapped — fatal accounting + auth", () => {
  it("a load_open failure logs ok=false with the fatal prefix and never calls the resolve RPC", async () => {
    const spy = install({
      unmapped_sales: { data: null, error: { message: "permission denied" } },
    })

    await POST(req())
    await runDeferred()

    const log = resolverLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false, p_rows_found: 0 })
    expect(String(log?.p_error)).toBe("load_open:permission denied")
    expect(spy.rpcCalls.some((c) => c.name === "resolve_unmapped_sales_for_collection")).toBe(false)
  })

  it("a resolve-RPC error surfaces as fatal ok=false", async () => {
    const spy = install({
      unmapped_sales: { data: [], error: null },
      "rpc:resolve_unmapped_sales_for_collection": { data: null, error: { message: "fn missing" } },
    })

    await POST(req())
    await runDeferred()

    const log = resolverLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toBe("resolve:fn missing")
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(req(null))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
