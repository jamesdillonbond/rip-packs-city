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
  cdc,
  cdcEvent,
  eventBlock,
  scriptResult,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
  V2_FLOWTY_LISTING_COMPLETED,
  v2DapperSalePayload as sharedV2DapperSalePayload,
  v1SalePayload as sharedV1SalePayload,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of POST /api/allday-sales-indexer — the money-attribution ingest
// path. Captures after() and feeds the real scan body Flow-REST fixtures in
// actual JSON-CDC encoding, so the inline unwrapCdc / extractNftTypeId /
// venue-classification / enrichment logic runs unmodified (test-only change; the
// route is untouched). Pins the correctness contracts:
//   - V2 Dapper AllDay sale -> `sales` row with marketplace 'nflallday',
//     source 'onchain_dapper_v2', wmc-resolved edition + serial, decoded buyer;
//   - non-AllDay nftTypes and cancellations are filtered out;
//   - V1 reduced payload -> cached_listings_v2 price + tx-decode buyer, and the
//     Cadence borrow fallback resolves nftID -> edition (nft_edition_map write);
//   - a price-UNCERTAIN V1 sale never lands in `sales` (goes to unmapped with
//     the extraction hint);
//   - an unresolvable sale lands in unmapped_sales with its resolution_hint;
//   - the cursor only advances after the scan, and every run logs pipeline_runs.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
  decodeByTx: {} as Record<
    string,
    {
      buyer?: string | null
      seller?: string | null
      priceDuc?: number | null
      priceCertain?: boolean
      priceReason?: string
      sampleAmounts?: number[]
    }
  >,
  decodeCalls: [] as Array<{ tx: string; nftId: string }>,
  hydrateResults: [] as Array<{ ok: boolean; external_id: string }>,
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
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string, opts: { nftId: string }) => {
    state.decodeCalls.push({ tx, nftId: opts.nftId })
    const d = state.decodeByTx[tx] ?? {}
    return {
      buyer: d.buyer ?? null,
      seller: d.seller ?? null,
      priceDuc: d.priceDuc ?? null,
      priceCertain: d.priceCertain ?? false,
      priceReason: d.priceReason ?? "no_duc_transfer",
      sampleAmounts: d.sampleAmounts ?? [],
    }
  },
}))
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateAllDayEditions: async (_ids: string[]) => state.hydrateResults,
  toUpsertRow: (r: { external_id: string }) => ({
    external_id: r.external_id,
    collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070",
    name: "Hydrated Edition",
  }),
}))

// TOKEN is read into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "indexer-token"

const { POST } = await import("@/app/api/allday-sales-indexer/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
const V1_TYPE = V1_LISTING_COMPLETED
const V2_DAPPER_TYPE = V2_DAPPER_LISTING_COMPLETED

const v2DapperSalePayload = (nftId: string, price: string, typeID = ALLDAY_NFT) =>
  sharedV2DapperSalePayload(nftId, price, typeID)
const v1SalePayload = (nftId: string, lrid: string, purchased = true, typeID = ALLDAY_NFT) =>
  sharedV1SalePayload(nftId, lrid, purchased, typeID)

// Flow REST stubs. Sealed height 1250 with cursor 1000 -> a single 250-block
// chunk (1001-1250), so each event fixture lands exactly once.
function flowRestStubs(events: {
  v1?: unknown[]
  v2Dapper?: unknown[]
  scripts?: Array<{ value: string }>
}): FetchStub[] {
  let scriptCall = 0
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    {
      match: (url) => url.includes("/v1/scripts"),
      respond: () => {
        const r = events.scripts?.[Math.min(scriptCall, (events.scripts?.length ?? 1) - 1)]
        scriptCall++
        return { json: r ?? scriptResult(null) }
      },
    },
    jsonRoute(encodeURIComponent(V2_DAPPER_TYPE), events.v2Dapper ?? []),
    jsonRoute(encodeURIComponent(V1_TYPE), events.v1 ?? []),
    // Flowty fork + any tx lookups default to empty.
    jsonRoute("/v1/events", []),
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
  ]
}

// A V2 Flowty ListingCompleted payload. The AllDay Flowty path reads buyer +
// storefrontAddress (seller) directly off the payload and tags the venue
// 'flowty'. flowRestStubs above has no flowty slot, so tests that need it build a
// stub set with flowtyStubs().
function v2FlowtySalePayload(nftId: string, price: string, buyer: string, seller: string, typeID = ALLDAY_NFT) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(8000 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    storefrontAddress: cdc.string(seller),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(typeID),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    customID: cdc.optionalNull(),
    buyer: cdc.string(buyer),
  })
}

function flowtyStubs(v2Flowty: unknown[]): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    { match: (url) => url.includes("/v1/scripts"), respond: () => ({ json: scriptResult(null) }) },
    jsonRoute(encodeURIComponent(V2_FLOWTY_LISTING_COMPLETED), v2Flowty),
    jsonRoute(encodeURIComponent(V2_DAPPER_TYPE), []),
    jsonRoute(encodeURIComponent(V1_TYPE), []),
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

// Make the first BATCH insert to `table` reject with `batchCode` (a 23505 dupe by
// default), then adjudicate each per-row RETRY via `isDupeRow` — the offending
// row resolves with a 23505 while every other row lands. This is the lever for
// proving the all-or-nothing insert contract at runtime: a batch that mixes ONE
// duplicate with NEW rows must drop only the duplicate and still write the rest.
// (makeInstrumentedSupabaseFixture's `failWrites` THROWS, which drives the
// fatal-catch path — a real 23505 RESOLVES with an error, a different branch.)
function withDupeAwareInsert(
  spy: ReturnType<typeof makeInstrumentedSupabaseFixture>,
  table: string,
  isDupeRow: (row: Record<string, unknown>) => boolean,
  batchCode = "23505",
) {
  const fixture = spy.fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = fixture.from.bind(fixture)
  let firstBatchSeen = false
  fixture.from = (t: string) => {
    const b = baseFrom(t)
    if (t === table) {
      const base = b.insert as (rows: unknown) => unknown
      b.insert = (rows: unknown) => {
        base(rows) // record the attempt in spy.writes
        if (Array.isArray(rows)) {
          if (!firstBatchSeen) {
            firstBatchSeen = true
            return Promise.resolve({ data: null, error: { code: batchCode, message: "duplicate key" } })
          }
          return Promise.resolve({ data: null, error: null })
        }
        if (isDupeRow(rows as Record<string, unknown>)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } })
        }
        return Promise.resolve({ data: null, error: null })
      }
    }
    return b
  }
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/allday-sales-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer indexer-token" }),
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
  process.env.INGEST_SECRET_TOKEN = "indexer-token"
  state.afterCbs.length = 0
  state.chained.length = 0
  state.decodeByTx = {}
  state.decodeCalls = []
  state.hydrateResults = []
})

describe("allday-sales-indexer — V2 Dapper primary path", () => {
  it("ingests an AllDay V2 sale: wmc edition+serial, decoded buyer, venue tags, cursor advance, ok log", async () => {
    const tx1 = "c".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1111111111111111", seller: "0x2222222222222222" }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1100, txId: tx1, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("555", "12.34000000") }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "555", edition_key: "789", serial_number: 33 }],
        error: null,
      },
      editions: { data: [{ id: "uuid-789", external_id: "789" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-789",
      collection_id: ALLDAY,
      collection: "nfl_all_day",
      nft_id: "555",
      price_usd: 12.34,
      serial_number: 33,
      marketplace: "nflallday",
      source: "onchain_dapper_v2",
      buyer_address: "0x1111111111111111",
      seller_address: "0x2222222222222222",
      transaction_hash: tx1,
      block_height: 1100,
    })
    // Nothing fell through to unmapped.
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

    // Cursor advanced to the scanned target height.
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1,
      p_rows_written: 1,
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    // Post-run chain: unmapped drain (forced) then fmv-recalc.
    expect(state.chained).toEqual([
      { path: "/api/cron/allday-resolve-unmapped", chain: true },
      { path: "/api/fmv-recalc", chain: false },
    ])
    // The finally block always fires the promote RPC.
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
  })


  // 🚨 A FAILED READ IS NOT AN EMPTY TABLE, and on this route the serial lookup
  // is the one that leaves a PERMANENT mark: `nft_edition_map` is the last
  // serial source before the sale row is written, and a sale written with a
  // NULL serial does not self-heal (the route's own comment records 1,325 that
  // landed that way while 1,321 had a serial available right there). The
  // resolution reads have the softer version of the same problem — every sale
  // parked as unresolvable, the Cadence budget spent, `unmapped_sales` flooded.
  // Asserted as the ABSENCE of the cursor advance and of any sale write.
  it("a failed wallet_moments_cache read holds the cursor and writes no sales", async () => {
    const txf = "d".repeat(64)
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1100, txId: txf, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("556", "9.00000000") }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: null, error: { message: "wmc read boom" } },
      editions: { data: [], error: null },
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    // ⛔ THE LOAD-BEARING ASSERTIONS.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(spy.writes.sales ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("wallet_moments_cache lookup")
  })

  it("filters non-AllDay nftTypes and V1 cancellations out of the sale set", async () => {
    const tx1 = "d".repeat(64)
    fetchMock = installFetchMock([
      ...flowRestStubs({
        // A Pinnacle NFT on V2 Dapper (the real venue mix) — must be ignored.
        v2Dapper: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_DAPPER_TYPE,
            payload: v2DapperSalePayload("999", "5.00000000", "A.edf9df96c92f4595.Pinnacle.NFT"),
          }),
        ],
        // An AllDay V1 CANCELLATION (purchased=false) — must be ignored.
        v1: [
          eventBlock({ height: 1101, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("888", "701", false) }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.v1_cancellations).toBe(1)
    // The observed V2 Dapper type mix is surfaced for venue-shift detection.
    expect(extra.v2_dapper_typeids_seen).toContain("A.edf9df96c92f4595.Pinnacle.NFT")
  })

  it("ingests a V2 Flowty sale: 'flowty' venue tag + payload buyer/seller", async () => {
    // The third storefront stream (Flowty fork) was never driven — every prior
    // fixture sent V1 or V2 Dapper events. The AllDay Flowty path reads buyer +
    // storefrontAddress off the payload and tags the venue 'flowty' (not the
    // 'nflallday' Dapper venue). A regression that mislabels the venue or drops
    // the buyer would misattribute the sale on every analytics split.
    const tx = "e".repeat(64)
    fetchMock = installFetchMock(
      flowtyStubs([
        eventBlock({
          height: 1108,
          txId: tx,
          eventType: V2_FLOWTY_LISTING_COMPLETED,
          payload: v2FlowtySalePayload("909", "6.75", "0x0d0d0d0d0d0d0d0d", "0x0e0e0e0e0e0e0e0e"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: { data: [{ moment_id: "909", edition_key: "88", serial_number: 4 }], error: null },
      editions: { data: [{ id: "uuid-fl-88", external_id: "88" }], error: null },
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      nft_id: "909",
      marketplace: "flowty",
      source: "onchain",
      price_usd: 6.75,
      buyer_address: "0x0d0d0d0d0d0d0d0d",
      seller_address: "0x0e0e0e0e0e0e0e0e",
    })
  })
})

describe("allday-sales-indexer — V1 reduced-payload enrichment", () => {
  it("V1 cache-hit price + tx-decoded buyer + Cadence borrow fallback resolves the edition end-to-end", async () => {
    const tx1 = "e".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x3333333333333333", seller: null }
    state.hydrateResults = [{ ok: true, external_id: "901" }]
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v1: [eventBlock({ height: 1102, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("606", "777") })],
        // The buyer-wallet borrow resolves editionID 901, serial 7.
        scripts: [
          scriptResult({ id: "606", editionID: "901", serialNumber: "7", mintingDate: "1700000000.0" }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: {
        data: [{ listing_resource_id: "777", price_usd: 25, seller_address: "0x4444444444444444" }],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null }, // cache miss -> borrow fallback
      editions: [
        { data: [], error: null }, // edition_key resolve: miss
        { data: [{ id: "uuid-901", external_id: "901" }], error: null }, // post-hydrate upsert returning
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    // The borrow resolution was persisted to the nft->edition map.
    const mapUpsert = spy.writes.nft_edition_map?.find((w) => w.method === "upsert")
    expect(mapUpsert?.rows[0]).toMatchObject({
      collection_id: ALLDAY,
      nft_id: "606",
      edition_external_id: "901",
      serial_number: 7,
    })
    // The hydrated edition row was upserted.
    const edUpsert = spy.writes.editions?.find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({ external_id: "901", name: "Hydrated Edition" })

    // The sale carries the cached price, decoded buyer, cached seller, V1 tags.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-901",
      nft_id: "606",
      price_usd: 25,
      serial_number: 7,
      marketplace: "nflallday",
      source: "onchain_dapper_v1",
      buyer_address: "0x3333333333333333",
      seller_address: "0x4444444444444444",
    })

    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1 })
    expect((log?.p_extra as Record<string, unknown>).v1_cache_hits).toBe(1)
    // The resolver leg logs its own pipeline row.
    const resolverRuns = spy.writes.pipeline_runs?.flatMap((w) => w.rows) ?? []
    expect(resolverRuns.some((r) => r.pipeline === "allday-edition-resolver" && r.rows_written === 1)).toBe(true)
  })

  it("falls back to nft_edition_map for the serial when wmc has no row and the borrow returns no serialNumber", async () => {
    // Regression pin for the 2026-07-31 finding: 8,626 AllDay sales were
    // written with a NULL serial across all three onchain sources. wmc holds
    // only moments in a walked wallet, so these NFTs had NO wmc row at all,
    // and the Cadence borrow resolved the edition while yielding no usable
    // serialNumber -> nftToSerial stayed empty -> NULL serial, which silently
    // excludes the sale from serial-level FMV, special-serials and jersey-match.
    // nft_edition_map already held the serial (promote_unmapped_sales reads it;
    // the direct-insert path did not).
    const tx1 = "1".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x7777777777777777", seller: "0x8888888888888888" }
    state.hydrateResults = [{ ok: true, external_id: "903" }]
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1104, txId: tx1, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("808", "50.00000000") }),
        ],
        // Borrow resolves the edition but carries no serialNumber.
        scripts: [scriptResult({ id: "808", editionID: "903", mintingDate: "1700000000.0" })],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null }, // no wmc row at all
      nft_edition_map: {
        data: [{ nft_id: "808", serial_number: 42 }],
        error: null,
      },
      editions: [
        { data: [], error: null },
        { data: [{ id: "uuid-903", external_id: "903" }], error: null },
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    // The map serial is used rather than NULL.
    expect(saleRows[0]).toMatchObject({
      nft_id: "808",
      edition_id: "uuid-903",
      serial_number: 42,
      source: "onchain_dapper_v2",
    })
    expect(saleRows[0].serial_number).not.toBeNull()
  })

  it("a price-UNCERTAIN V1 sale never lands in `sales` — it goes to unmapped with the extraction hint", async () => {
    const tx1 = "f".repeat(64)
    state.decodeByTx[tx1] = {
      buyer: "0x5555555555555555",
      seller: "0x6666666666666666",
      priceCertain: false,
      priceReason: "multiple_duc_transfers",
      sampleAmounts: [10, 90],
    }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v1: [eventBlock({ height: 1103, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("707", "778") })],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: { data: [], error: null }, // no cached price -> full decode
      wallet_moments_cache: {
        data: [{ moment_id: "707", edition_key: "902", serial_number: 4 }],
        error: null,
      },
      editions: { data: [{ id: "uuid-902", external_id: "902" }], error: null },
    })

    await POST(req())
    await runDeferred()

    // Even though the edition RESOLVED, the uncertain price blocks the sales write.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({
      collection_id: ALLDAY,
      nft_id: "707",
      price_usd: 0,
      source: "onchain_dapper_v1",
      buyer_address: "0x5555555555555555",
    })
    expect(unmapped[0].resolution_hint).toMatchObject({
      nft_id: "707",
      sale_source: "v1_dapper",
      price_extraction: "multiple_duc_transfers",
      sample_duc_amounts: [10, 90],
    })
  })
})

describe("allday-sales-indexer — degradation + control flow", () => {
  // ── fetchTxBuyers: buyer recovery when the sale carries no buyer ──────────
  //
  // The Cadence fallback resolver borrows the moment FROM A CANDIDATE WALLET to
  // learn its edition + serial, so it needs an address. When the sale itself has
  // no buyer it recovers candidates from the transaction's proposer /
  // authorizers / payer — and must drop the three INFRASTRUCTURE addresses,
  // because a Flowty-fork sale names the fee router rather than the collector
  // (CLAUDE.md, per-collection Cadence gotchas).
  //
  // Two things go wrong if EXCLUDED_ADDRESSES stops applying, and only the first
  // is loud: the borrow is attempted against a wallet that does not hold the
  // moment (wasted Cadence calls), and — the real cost — an infrastructure
  // address becomes a plausible "buyer" for downstream attribution.
  //
  // This path was entirely uncovered: every existing resolver case supplies a
  // decoded buyer, so `candidates.length === 0` was never reached.
  it("recovers buyer candidates from the tx when the sale has none, and drops the infrastructure addresses", async () => {
    const tx1 = "f".repeat(64)
    // No buyer from the V1 decode -> candidates start empty -> fetchTxBuyers runs.
    state.decodeByTx[tx1] = { buyer: null, seller: null }
    state.hydrateResults = [{ ok: true, external_id: "902" }]

    // Every Address argument the borrow script was called with.
    const borrowAddresses: string[] = []

    fetchMock = installFetchMock([
      // Must precede flowRestStubs' catch-all, which answers this route empty.
      {
        match: (url) => url.includes("/v1/transactions/"),
        respond: () => ({
          json: {
            // Flowty fee payer — excluded.
            proposal_key: { address: "0x18eb4ee6b3c026d2" },
            // Flowty storefront escrow (excluded) + the real collector.
            authorizers: ["0x3cdbb3d569211ff3", "0x9999999999999999"],
            // Dapper DUC co-signer — excluded.
            payer: "0xead892083b3e2c6c",
          },
        }),
      },
      {
        match: (url) => url.includes("/v1/scripts"),
        respond: (_url, init) => {
          const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}"))
          for (const a of (body.arguments ?? []) as string[]) {
            const arg = JSON.parse(Buffer.from(a, "base64").toString("utf8"))
            if (arg?.type === "Address") borrowAddresses.push(String(arg.value))
          }
          return {
            json: scriptResult({
              id: "607",
              editionID: "902",
              serialNumber: "11",
              mintingDate: "1700000000.0",
            }),
          }
        },
      },
      ...flowRestStubs({
        v1: [eventBlock({ height: 1103, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("607", "778") })],
      }),
    ])

    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: {
        data: [{ listing_resource_id: "778", price_usd: 30, seller_address: "0x4444444444444444" }],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
      editions: [
        { data: [], error: null },
        { data: [{ id: "uuid-902", external_id: "902" }], error: null },
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    // THE ASSERTION: the borrow used the collector, never an infrastructure wallet.
    expect(borrowAddresses).toContain("0x9999999999999999")
    for (const infra of ["0x18eb4ee6b3c026d2", "0x3cdbb3d569211ff3", "0xead892083b3e2c6c"]) {
      expect(borrowAddresses, `${infra} is infrastructure and must never be borrowed against`).not.toContain(infra)
    }

    // Recovery actually produced a resolution rather than merely not crashing.
    const mapUpsert = spy.writes.nft_edition_map?.find((w) => w.method === "upsert")
    expect(mapUpsert?.rows[0]).toMatchObject({
      nft_id: "607",
      edition_external_id: "902",
      serial_number: 11,
    })
  })

  // The mirror case: when the tx yields ONLY infrastructure addresses there is no
  // candidate at all, and the resolver must SKIP rather than borrow against one.
  it("skips the resolve when the tx yields only infrastructure addresses", async () => {
    const tx1 = "c".repeat(63) + "d"
    state.decodeByTx[tx1] = { buyer: null, seller: null }
    let borrowCalls = 0

    fetchMock = installFetchMock([
      {
        match: (url) => url.includes("/v1/transactions/"),
        respond: () => ({
          json: {
            proposal_key: { address: "0x18eb4ee6b3c026d2" },
            authorizers: ["0x3cdbb3d569211ff3"],
            payer: "0xead892083b3e2c6c",
          },
        }),
      },
      {
        match: (url) => url.includes("/v1/scripts"),
        respond: () => {
          borrowCalls++
          return { json: scriptResult(null) }
        },
      },
      ...flowRestStubs({
        v1: [eventBlock({ height: 1103, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("609", "779") })],
      }),
    ])

    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: {
        data: [{ listing_resource_id: "779", price_usd: 12, seller_address: "0x4444444444444444" }],
        error: null,
      },
      wallet_moments_cache: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    expect(borrowCalls, "no candidate survives the filter, so nothing is borrowed").toBe(0)
    // The sale is not silently dropped — it lands in unmapped for a later pass.
    expect((spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)).toHaveLength(1)
  })

  it("an unresolvable sale (wmc miss, borrow nil) lands in unmapped_sales with its hint", async () => {
    const tx1 = "a".repeat(63) + "b"
    state.decodeByTx[tx1] = { buyer: "0x7777777777777777" }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1104, txId: tx1, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("808", "3.50000000") }),
        ],
        scripts: [scriptResult(null)], // borrow returns nil
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({
      nft_id: "808",
      price_usd: 3.5,
      // NULL, not 0: a literal 0 wins promote_unmapped_sales' COALESCE and makes
      // its nft_edition_map/wmc serial fallback unreachable. This assertion
      // previously pinned the 0 (i.e. pinned the bug).
      serial_number: null,
      marketplace: "nflallday",
      source: "onchain_dapper_v2",
    })
    expect(unmapped[0].resolution_hint).toMatchObject({ nft_id: "808", sale_source: "v2_dapper" })
    // Skipped (unmapped) rows are counted separately from written rows.
    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
  })

  it("already-up-to-date short-circuits the scan but still chains + logs", async () => {
    fetchMock = installFetchMock([...flowRestStubs({})])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1250 }, error: null },
    })

    await POST(req())
    await runDeferred()

    // No event scan happened (only the sealed-height probe).
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect(state.chained).toEqual([
      { path: "/api/cron/allday-resolve-unmapped", chain: true },
      { path: "/api/fmv-recalc", chain: false },
    ])
    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect((log?.p_extra as Record<string, unknown>).message).toBe("already up to date")
    expect(log?.p_ok).toBe(true)
  })

  it("a cursor-read failure logs ok=false and still runs the finally-block promote + logging", async () => {
    fetchMock = installFetchMock([...flowRestStubs({})])
    const spy = install({
      event_cursor: { data: null, error: { message: "permission denied" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("cursor read error")
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/allday-sales-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})

describe("allday-sales-indexer — 23505 all-or-nothing insert contract", () => {
  // AllDay is the highest-volume money-attribution indexer and the one whose
  // batch-insert failure branch was entirely unexercised at runtime. A batch
  // insert is all-or-nothing: a single 23505 fails the whole statement and
  // writes NONE of the batch, so swallowing it discards every co-batched NEW row
  // permanently (the block cursor advances past them regardless). These pin that
  // the row-by-row fallback drops only the dupe.

  it("drops ONLY the dupe on the sales batch — the co-batched NEW sale still lands", async () => {
    const txDupe = "2".repeat(64)
    const txNew = "3".repeat(64)
    state.decodeByTx[txDupe] = { buyer: "0x1111111111111111", seller: "0x2222222222222222" }
    state.decodeByTx[txNew] = { buyer: "0x3333333333333333", seller: "0x4444444444444444" }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1100, txId: txDupe, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("555", "12.00000000") }),
          eventBlock({ height: 1101, txId: txNew, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("556", "34.00000000") }),
        ],
      }),
    ])
    const spy = withDupeAwareInsert(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: {
          data: [
            { moment_id: "555", edition_key: "789", serial_number: 33 },
            { moment_id: "556", edition_key: "790", serial_number: 34 },
          ],
          error: null,
        },
        editions: {
          data: [
            { id: "uuid-789", external_id: "789" },
            { id: "uuid-790", external_id: "790" },
          ],
          error: null,
        },
        sales: { data: null, error: null },
      }),
      "sales",
      (row) => row.nft_id === "555", // the dupe
    )

    await POST(req())
    await runDeferred()

    const inserts = spy.writes.sales ?? []
    const batch = inserts.find((w) => Array.isArray(w.rows) && w.rows.length === 2)
    expect(batch).toBeTruthy()
    const perRow = inserts.filter((w) => w.rows.length === 1).flatMap((w) => w.rows)
    expect(perRow.map((r) => r.nft_id).sort()).toEqual(["555", "556"])
    // Exactly the survivor is counted: NOT 0 (the pre-fix all-or-nothing loss),
    // NOT 2 (which would mean the dupe was silently re-counted).
    expect(terminalLog(spy.rpcCalls, "allday-sales-indexer")).toMatchObject({ p_rows_written: 1 })
  })

  it("retries row-by-row on a NON-dupe batch error too — both rows land", async () => {
    // A transient connection error (08006) is not a dupe; every row is genuinely
    // new, so the row-by-row fallback must land ALL of them, not swallow the batch.
    const tx1 = "4".repeat(64)
    const tx2 = "5".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1111111111111111", seller: null }
    state.decodeByTx[tx2] = { buyer: "0x2222222222222222", seller: null }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1100, txId: tx1, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("557", "1.00000000") }),
          eventBlock({ height: 1101, txId: tx2, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("558", "2.00000000") }),
        ],
      }),
    ])
    const spy = withDupeAwareInsert(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: {
          data: [
            { moment_id: "557", edition_key: "789", serial_number: 1 },
            { moment_id: "558", edition_key: "790", serial_number: 2 },
          ],
          error: null,
        },
        editions: {
          data: [
            { id: "uuid-789", external_id: "789" },
            { id: "uuid-790", external_id: "790" },
          ],
          error: null,
        },
        sales: { data: null, error: null },
      }),
      "sales",
      () => false, // nothing is a dupe on retry -> both land
      "08006",
    )

    await POST(req())
    await runDeferred()

    expect(terminalLog(spy.rpcCalls, "allday-sales-indexer")).toMatchObject({ p_rows_written: 2 })
  })

  it("drops only the dupe on the unmapped_sales batch too", async () => {
    // The second writer in this body: sales whose edition can't be resolved are
    // parked in unmapped_sales in their own batch, and its row-by-row fallback
    // feeds rows_skipped. One dupe + one new -> the new parked row survives.
    const txDupe = "6".repeat(64)
    const txNew = "7".repeat(64)
    state.decodeByTx[txDupe] = { buyer: "0x5555555555555555" }
    state.decodeByTx[txNew] = { buyer: "0x6666666666666666" }
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 1100, txId: txDupe, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("881", "3.00000000") }),
          eventBlock({ height: 1101, txId: txNew, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("882", "4.00000000") }),
        ],
        scripts: [scriptResult(null), scriptResult(null)], // borrow resolves nothing -> unmapped
      }),
    ])
    const spy = withDupeAwareInsert(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: { data: [], error: null },
      }),
      "unmapped_sales",
      (row) => row.nft_id === "881",
    )

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const perRow = (spy.writes.unmapped_sales ?? []).filter((w) => w.rows.length === 1).flatMap((w) => w.rows)
    expect(perRow.map((r) => r.nft_id).sort()).toEqual(["881", "882"])
    expect(terminalLog(spy.rpcCalls, "allday-sales-indexer")).toMatchObject({ p_rows_skipped: 1 })
  })
})

describe("allday-sales-indexer — on-chain edition metadata fallback (buildOnChainEditionRow)", () => {
  // A sale whose edition is resolved via the Cadence BORROW fallback (wmc miss),
  // is NOT in `editions`, and which the AllDay relay FAILS to hydrate
  // (hydrateResults ok:false), falls through to the on-chain GET_EDITION_DATA
  // path — the only writer of buildOnChainEditionRow, the pure mapper that turns
  // the on-chain {String:String} blob into an editions row. A regression here
  // silently corrupts an edition's circulation / tier / series / game-date /
  // display name for every downstream FMV + wallet read.
  //
  // Script call order in the V1 borrow path: [0] BORROW_MOMENT (resolve
  // editionID+serial), [1] GET_EDITION_DATA (the metadata mapped below).
  it("maxMintSize wins for circulation; full metadata + valid date + tier normalize", async () => {
    const tx1 = "1".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1111111111111111", seller: "0x2222222222222222" }
    state.hydrateResults = [{ ok: false, external_id: "789" }] // relay miss -> on-chain fallback
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v1: [eventBlock({ height: 1102, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("606", "777") })],
        scripts: [
          scriptResult({ id: "606", editionID: "789", serialNumber: "33", mintingDate: "1700000000.0" }),
          scriptResult({
            playerName: "Patrick Mahomes",
            setName: "Base Series 4",
            teamName: "Chiefs",
            numMinted: "1200",
            maxMintSize: "5000",
            seriesID: "4",
            setID: "12",
            playID: "345",
            dateOfMoment: "2024-09-08T00:00:00",
            playType: "Pass",
            homeTeamName: "Chiefs",
            awayTeamName: "Ravens",
            tier: "Legendary Edition",
          }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: { data: [{ listing_resource_id: "777", price_usd: 25, seller_address: "0x4444444444444444" }], error: null },
      wallet_moments_cache: { data: [], error: null }, // cache miss -> borrow fallback
      editions: [
        { data: [], error: null }, // edition_key resolve: miss
        { data: [], error: null }, // post-fallback upsert returns nothing (fine)
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const row = (spy.writes.editions ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
      .find((r) => r.external_id === "789")
    expect(row).toBeTruthy()
    expect(row).toMatchObject({
      external_id: "789",
      collection_id: ALLDAY,
      player_name: "Patrick Mahomes",
      set_name: "Base Series 4",
      team_name: "Chiefs",
      tier: "LEGENDARY",
      series: 4,
      set_id_onchain: 12,
      play_id_onchain: 345,
      circulation_count: 5000, // maxMintSize wins over numMinted
      game_date: "2024-09-08",
      name: "Patrick Mahomes — Base Series 4",
    })
  })

  it("falls back to numMinted when maxMintSize is 0; single-field name, unknown tier→null, invalid date→null", async () => {
    const tx1 = "2".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x3333333333333333", seller: "0x4444444444444444" }
    state.hydrateResults = [{ ok: false, external_id: "790" }]
    fetchMock = installFetchMock([
      ...flowRestStubs({
        v1: [eventBlock({ height: 1102, txId: tx1, eventType: V1_TYPE, payload: v1SalePayload("607", "778") })],
        scripts: [
          scriptResult({ id: "607", editionID: "790", serialNumber: "5", mintingDate: "1700000000.0" }),
          scriptResult({
            playerName: "", // empty -> name falls back to setName
            setName: "Rookie Set",
            maxMintSize: "0", // -> circulation falls back to numMinted
            numMinted: "250",
            seriesID: "0", // -> series null (not > 0)
            setID: "7",
            playID: "8",
            dateOfMoment: "not-a-date", // -> game_date null
            tier: "Fandom", // -> not a recognized AllDay tier -> null
          }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: { data: [{ listing_resource_id: "778", price_usd: 9, seller_address: "0x4444444444444444" }], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: [
        { data: [], error: null },
        { data: [], error: null },
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const row = (spy.writes.editions ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
      .find((r) => r.external_id === "790")
    expect(row).toBeTruthy()
    expect(row).toMatchObject({
      external_id: "790",
      player_name: null,
      name: "Rookie Set", // composed name uses setName when playerName is empty
      circulation_count: 250, // numMinted fallback
      series: null,
      tier: null,
      game_date: null,
    })
  })
  // ── The cursor must NEVER leapfrog a chunk that failed to scan ────────────
  //
  // This is the same permanent-loss class as the batch-insert 23505 defect: if a
  // chunk's fetch fails and the cursor still advances to targetHeight, every sale
  // in that block range is skipped FOREVER — the next tick starts after it.
  // Nothing errors, nothing retries, the rows simply never exist.
  //
  // Driven with a two-chunk scan (CHUNK_SIZE 250, cursor at 750, sealed 1250) so
  // the FIRST chunk succeeds and the SECOND throws. A single-chunk fixture cannot
  // distinguish "held the cursor" from "never advanced it at all", which is why
  // the range is widened rather than reusing the default one-chunk setup.
  it("caps the cursor below the FIRST failed chunk and records the partial scan", async () => {
    const tx1 = "e".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1111111111111111", seller: "0x2222222222222222" }
    fetchMock = installFetchMock([
      // Sealed at 1500 with the cursor at 750 gives THREE chunks (751-1000,
      // 1001-1250, 1251-1500). Listed before flowRestStubs so this height wins.
      jsonRoute("blocks?height=sealed", [{ header: { height: "1500" } }]),
      // ⚠ TWO chunks fail, not one. With a single failure the first and last
      // failed chunk are the same block, so a mutation that records the LAST
      // one is indistinguishable — verified, it SURVIVED a one-chunk fixture.
      // Two failures are what make `if (first === null)` load-bearing.
      {
        match: (u: string) =>
          (u.includes("start_height=1001") || u.includes("start_height=1251")) &&
          u.includes(encodeURIComponent(V2_DAPPER_TYPE)),
        respond: () => {
          throw new Error("ECONNRESET")
        },
      },
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({ height: 900, txId: tx1, eventType: V2_DAPPER_TYPE, payload: v2DapperSalePayload("555", "12.34000000") }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 750 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "555", edition_key: "789", serial_number: 33 }],
        error: null,
      },
      editions: { data: [{ id: "uuid-789", external_id: "789" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    // The first chunk's sale still lands — a partial scan keeps what it read.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({ nft_id: "555", block_height: 900 })

    // ⚠ THE ASSERTION THAT MATTERS. 1000 = FIRST failed chunk (1001) - 1, NOT
    // targetHeight (1500) and NOT the last failed chunk (1251) - 1. Either wrong
    // answer silently skips real blocks on every future tick.
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1000 })

    // And the run says so, rather than reporting a clean full scan.
    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra?.partial_scan).toBe(true)
    expect(extra?.first_failed_chunk).toBe(1001)
    expect(extra?.cursor_held_from).toBe(1500)
  })

  // ⚠ THE HTTP PATH, WHICH USED TO BE THE HOLE. This case began life as a probe
  // that FAILED: with an HTTP 500 on chunk 1001-1250 the cursor advanced to 1500
  // instead of holding at 1000, because `fetchEventRange` swallowed `!res.ok`
  // into `[]` and the chunk read as genuinely EMPTY. The catch above only ever
  // saw THROWN errors, so the cap never fired and those blocks were never
  // revisited — permanent loss, behind a clean `ok: true` run.
  //
  // ⚠ ITS SIBLING ABOVE CANNOT CATCH THIS, and that is the lesson worth keeping:
  // every cursor-hold test in this family simulated failure by THROWING
  // (ECONNRESET), which is the path that already worked. "The chunk failed" and
  // "the chunk threw" were not the same set, and the whole family was blind to
  // the difference. Fixed 2026-08-21 across 7 routes; this is the regression.
  it("an upstream HTTP error holds the cursor too, not just a thrown one", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1500" } }]),
      {
        match: (u: string) =>
          u.includes("start_height=1001") && u.includes(encodeURIComponent(V2_DAPPER_TYPE)),
        respond: () => ({ status: 500, ok: false, json: {}, text: "upstream boom" }),
      },
      // ⚠ The THIRD chunk (1251-1500) is served EMPTY on purpose. The shared
      // `flowRestStubs` fixture answers every V2-Dapper chunk with the same
      // block-900 event, so without this the surviving chunks BOTH emit it and
      // the row count below stops distinguishing "the first chunk's read was
      // kept" from "every chunk was replayed" — the assertion would pass for the
      // wrong reason. Empty here makes the surviving row uniquely the first
      // chunk's, which is the property a partial scan has to hold.
      jsonRoute("start_height=1251", []),
      ...flowRestStubs({
        v2Dapper: [
          eventBlock({
            height: 900,
            txId: tx1,
            eventType: V2_DAPPER_TYPE,
            payload: v2DapperSalePayload("555", "12.34000000"),
          }),
        ],
      }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 750 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "555", edition_key: "789", serial_number: 33 }],
        error: null,
      },
      editions: { data: [{ id: "uuid-789", external_id: "789" }], error: null },
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    // 1000 = the failed chunk (1001) - 1. Not 1500.
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(
      cursorUpdate?.rows[0],
      "an HTTP 500 must hold the cursor exactly as a thrown error does",
    ).toMatchObject({ last_processed_block: 1000 })

    // And it must be REPORTED as partial, not logged as a clean full scan —
    // otherwise the hold works and no operator ever learns the range was short.
    const log = terminalLog(spy.rpcCalls, "allday-sales-indexer")
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra?.partial_scan).toBe(true)
    expect(extra?.first_failed_chunk).toBe(1001)

    // A partial scan KEEPS what it successfully read — holding the cursor must
    // not also throw away the chunks that worked. The one surviving row is the
    // FIRST chunk's (block 900); the third chunk is stubbed empty, so this
    // cannot pass by replaying the same fixture through every chunk.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({ nft_id: "555", block_height: 900 })
  })
})
