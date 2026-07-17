import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import {
  eventBlock,
  v2DapperSalePayload,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of the Golazos + UFC sales indexers — structural siblings of the
// AllDay indexer (same three-storefront scan, same enrichment ladder) with
// per-collection venue tags and NFT-type filters. One happy path + the
// wrong-collection filter each, pinning the venue/collection constants that a
// copy-paste drift would silently corrupt:
//   golazos: .Golazos.NFT -> marketplace 'laligagolazos', collection laliga_golazos
//   ufc:     .UFC_NFT.NFT -> marketplace 'ufcstrike',     collection ufc_strike

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null }>,
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
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string) => {
    const d = state.decodeByTx[tx] ?? {}
    return {
      buyer: d.buyer ?? null,
      seller: d.seller ?? null,
      priceDuc: null,
      priceCertain: false,
      priceReason: "no_duc_transfer",
      sampleAmounts: [],
    }
  },
}))

process.env.INGEST_SECRET_TOKEN = "sibling-token"

const golazos = await import("@/app/api/golazos-sales-indexer/route")
const ufc = await import("@/app/api/ufc-sales-indexer/route")

const GOLAZOS_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const UFC_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

// Sealed height 1250 + cursor 1000 -> one 250-block chunk; each fixture lands once.
function flowRestStubs(v2Dapper: unknown[]): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    jsonRoute("/v1/scripts", { value: "" }),
    jsonRoute(encodeURIComponent(V2_DAPPER_LISTING_COMPLETED), v2Dapper),
    jsonRoute(encodeURIComponent(V1_LISTING_COMPLETED), []),
    jsonRoute("/v1/events", []),
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(path: string): NextRequest {
  return new NextRequest(`https://t${path}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer sibling-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline)
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "sibling-token"
  state.afterCbs.length = 0
  state.chained.length = 0
  state.decodeByTx = {}
})

describe("golazos-sales-indexer", () => {
  it("ingests a Golazos V2 Dapper sale with the laligagolazos venue tag", async () => {
    const tx1 = "5".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1010101010101010", seller: "0x2020202020202020" }
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1100,
          txId: tx1,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("444", "9.99000000", "A.87ca73a41bb50ad5.Golazos.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "444", edition_key: "55" }],
        error: null,
      },
      editions: { data: [{ id: "uuid-g55", external_id: "55" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await golazos.POST(req("/api/golazos-sales-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-g55",
      collection_id: GOLAZOS_ID,
      collection: "laliga_golazos",
      nft_id: "444",
      price_usd: 9.99,
      // wmc carries no serial for Golazos/UFC; the borrow fallback is the only
      // serial source here, and the sales-table trigger coerces 0 -> NULL.
      serial_number: 0,
      marketplace: "laligagolazos",
      source: "onchain_dapper_v2",
      buyer_address: "0x1010101010101010",
    })
    const log = terminalLog(spy.rpcCalls, "golazos-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_cursor_after: "1250" })
  })

  it("ignores non-Golazos NFT types on the shared storefront", async () => {
    const tx = "6".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1101,
          txId: tx,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("445", "1.00000000", "A.e4cf4bdc1751c65d.AllDay.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await golazos.POST(req("/api/golazos-sales-indexer"))
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls, "golazos-sales-indexer")).toMatchObject({ p_rows_found: 0 })
  })
})

describe("ufc-sales-indexer", () => {
  it("ingests a UFC V2 Dapper sale with the ufcstrike venue tag", async () => {
    const tx1 = "7".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x3030303030303030", seller: null }
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1102,
          txId: tx1,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("333", "4.20000000", "A.329feb3ab062d289.UFC_NFT.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "333", edition_key: "88" }],
        error: null,
      },
      editions: { data: [{ id: "uuid-u88", external_id: "88" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await ufc.POST(req("/api/ufc-sales-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-u88",
      collection_id: UFC_ID,
      collection: "ufc_strike",
      nft_id: "333",
      price_usd: 4.2,
      serial_number: 0,
      marketplace: "ufcstrike",
      source: "onchain_dapper_v2",
      buyer_address: "0x3030303030303030",
    })
    const log = terminalLog(spy.rpcCalls, "ufc-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_cursor_after: "1250" })
  })

  it("ignores non-UFC NFT types and 401s without the token", async () => {
    const tx = "8".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1103,
          txId: tx,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("334", "1.00000000", "A.edf9df96c92f4595.Pinnacle.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await ufc.POST(req("/api/ufc-sales-indexer"))
    await runDeferred()
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls, "ufc-sales-indexer")).toMatchObject({ p_rows_found: 0 })

    const unauthorized = await ufc.POST(
      new NextRequest("https://t/api/ufc-sales-indexer", { method: "POST" }),
    )
    expect(unauthorized.status).toBe(401)
  })
})
