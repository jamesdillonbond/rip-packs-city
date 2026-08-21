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
  v1SalePayload,
  v2DapperSalePayload,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
  V2_FLOWTY_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// The AllDay backward walker's undriven arms — the sibling of the UFC edges
// suite, covering the same shared shapes on the family's largest copy:
//
//   - the 23505 row-by-row retry on BOTH the `sales` and `unmapped_sales` batch
//     inserts. A batch .insert() is all-or-nothing, so one duplicate fails the
//     whole ≤100-row statement; the positive-23505 branch IS the retry here (the
//     correct shape per CLAUDE.md) and must salvage every co-batched NEW row,
//     while a non-dupe error must NOT retry.
//   - the V2 DAPPER venue. It stays armed even though that storefront
//     historically carried packs rather than AllDay moments — so the arm is
//     effectively dead in production, which is exactly why it needs a test: if a
//     window ever does surface an AllDay moment there, nothing else would catch
//     a regression in it first.
//   - ?dryRun=true, which must decode a sample and write NOTHING — no sales, no
//     unmapped rows, no cursor move, no promote.
//   - fetchEventRange's spork-floor 404 vs any other failing status.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null; priceDuc?: number | null; priceCertain?: boolean; priceReason?: string; sampleAmounts?: number[] }>,
  decodeCalls: [] as Array<{ tx: string; nftId: string; deposit: string; withdraw: string }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string, opts: { nftId: string; depositEventType: string; withdrawEventType: string }) => {
    state.decodeCalls.push({ tx, nftId: opts.nftId, deposit: opts.depositEventType, withdraw: opts.withdrawEventType })
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

process.env.INGEST_SECRET_TOKEN = "history-token"
const { POST } = await import("@/app/api/cron/allday-sales-history-backfill/route")

const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
const CEILING = 137_400_000

function v2FlowtySalePayload(nftId: string, price: string) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9000 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(ALLDAY_NFT),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    storefrontAddress: { type: "Address", value: "0xaaaaaaaaaaaaaaaa" },
    buyer: { type: "Address", value: "0xbbbbbbbbbbbbbbbb" },
    customID: cdc.optionalNull(),
  })
}

interface FlowEvents {
  v1?: unknown[]
  v2d?: unknown[]
  v2Flowty?: unknown[]
  v1Response?: { status: number; text: string }
}

function flowStubs(events: FlowEvents): FetchStub[] {
  const stubs: FetchStub[] = [
    { match: (u) => u.includes("/v1/scripts"), respond: () => ({ json: scriptResult(null) }) },
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", events.v2Flowty ?? []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", events.v2d ?? []),
  ]
  stubs.push(
    events.v1Response
      ? {
          match: (u) => u.includes("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"),
          respond: () => ({ status: events.v1Response!.status, ok: false, text: events.v1Response!.text }),
        }
      : jsonRoute("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted", events.v1 ?? []),
  )
  return stubs
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const req = (qs = "?range=250") =>
  new NextRequest(`https://t/api/cron/allday-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer history-token" }),
  })

const terminalLog = (rpcCalls: RecordedRpcCall[]) =>
  rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined

function mappedFixtures(over: Fixtures = {}): Fixtures {
  return {
    event_cursor: { data: { last_processed_block: CEILING }, error: null },
    wallet_moments_cache: {
      data: [
        { moment_id: "555", edition_key: "AD-EDITION-1", serial_number: 12 },
        { moment_id: "777", edition_key: "AD-EDITION-2", serial_number: 3 },
      ],
      error: null,
    },
    editions: {
      data: [
        { id: "uuid-ad-1", external_id: "AD-EDITION-1" },
        { id: "uuid-ad-2", external_id: "AD-EDITION-2" },
      ],
      error: null,
    },
    ...over,
  }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "history-token"
  delete process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("allday-sales-history-backfill — batch-insert dedupe retry", () => {
  const twoFlowtySales = () =>
    flowStubs({
      v2Flowty: [
        eventBlock({ height: CEILING - 100, txId: "a".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: v2FlowtySalePayload("555", "5.00000000") }),
        eventBlock({ height: CEILING - 101, txId: "b".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: v2FlowtySalePayload("777", "6.00000000") }),
      ],
    })

  it("retries a duplicate-poisoned sales batch row-by-row so co-batched NEW rows still land", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(
      mappedFixtures({
        sales: [
          { data: null, error: { code: "23505", message: "duplicate key value" } },
          { data: null, error: null },
          { data: null, error: { code: "23505", message: "duplicate key value" } },
        ],
      }),
    )

    expect((await POST(req())).status).toBe(200)
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(3)
    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(1)
  })

  it("does NOT retry a non-duplicate insert error", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(mappedFixtures({ sales: { data: null, error: { code: "23502", message: "null value in column" } } }))

    await POST(req())
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(1)
    expect(terminalLog(spy.rpcCalls)!.p_rows_written).toBe(0)
  })

  it("applies the same retry to the unmapped_sales batch", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(
      mappedFixtures({
        wallet_moments_cache: { data: [], error: null },
        editions: { data: [], error: null },
        unmapped_sales: [
          { data: null, error: { code: "23505", message: "duplicate key value" } },
          { data: null, error: null },
          { data: null, error: null },
        ],
      }),
    )

    await POST(req())
    expect((spy.writes.unmapped_sales ?? []).filter((w) => w.method === "insert")).toHaveLength(3)
    expect(terminalLog(spy.rpcCalls)!.p_rows_skipped).toBe(2)
  })
})

describe("allday-sales-history-backfill — the (dormant) V2 Dapper arm", () => {
  it("ingests a purchased AllDay moment there and filters the cancellation + foreign type", async () => {
    const tx = "d".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0505050505050505", seller: "0x0606060606060606" }
    fetchMock = installFetchMock(
      flowStubs({
        v2d: [
          eventBlock({ height: CEILING - 50, txId: tx, eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("555", "9.00000000", ALLDAY_NFT) }),
          eventBlock({
            height: CEILING - 51,
            txId: "e".repeat(64),
            eventType: V2_DAPPER_LISTING_COMPLETED,
            payload: cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
              listingResourceID: cdc.uint64(1),
              storefrontResourceID: cdc.uint64(1),
              purchased: cdc.bool(false),
              nftType: cdc.nftType(ALLDAY_NFT),
              nftID: cdc.uint64("777"),
              salePrice: cdc.ufix64("1.00000000"),
              customID: cdc.optionalNull(),
              commissionReceiver: cdc.optionalNull(),
            }),
          }),
          // A TopShot PackNFT — what this storefront actually carried.
          eventBlock({ height: CEILING - 52, txId: "f".repeat(64), eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("999", "3.00000000", "A.0b2a3299cc857e29.PackNFT.NFT") }),
        ],
      }),
    )
    const spy = install(mappedFixtures())

    await POST(req())

    const rows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ nft_id: "555", price_usd: 9, buyer_address: "0x0505050505050505" })
    // The decode is pointed at the AllDay contract's Deposit/Withdraw events.
    expect(state.decodeCalls[0]).toMatchObject({
      deposit: "A.e4cf4bdc1751c65d.AllDay.Deposit",
      withdraw: "A.e4cf4bdc1751c65d.AllDay.Withdraw",
    })
    const extra = terminalLog(spy.rpcCalls)!.p_extra as Record<string, unknown>
    expect(extra.rawV2Dapper).toBe(3)
    expect(extra.v2DapperIn).toBe(1)
  })
})

describe("allday-sales-history-backfill — dryRun + range failures", () => {
  it("?dryRun=true decodes a sample and writes NOTHING", async () => {
    const tx = "1".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0101010101010101", seller: "0x0202020202020202", priceDuc: 30, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({ v1: [eventBlock({ height: CEILING - 200, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "901", true, ALLDAY_NFT) })] }),
    )
    const spy = install(mappedFixtures())

    const res = await POST(req("?range=250&dryRun=true"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, mode: "dryRun", found: 1 })

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(false)
  })

  it("holds the backward cursor on a 500 and stops honestly at the spork floor — the two non-2xx cases are NOT the same", async () => {
    // ⚠ INVERTED 2026-08-21, NOT deleted. This case previously ended
    //   expect(status).toBe(200); expect(below_floor).toBe(false); expect(rows_found).toBe(0)
    // under the title "...treats any other status as an empty range" — i.e. it
    // ASSERTED that an upstream 500 should read as a window containing no sales.
    // It does not: these crons walk history BACKWARD and then move the cursor to
    // `start`, so an unread window ends up ABOVE the cursor and nothing ever
    // returns to it. A passing assertion is what held that in place.
    //
    // The two non-2xx cases must stay DISTINGUISHABLE, which is the whole reason
    // this family could not take the blanket throw the forward indexers took:
    //   404 "is less than"  → the node's block floor. Legitimate stop, cursor advances.
    //   anything else       → a failed read. Cursor must NOT move.
    fetchMock = installFetchMock(flowStubs({ v1Response: { status: 404, text: "start height 1 is less than the spork root block height" } }))
    const spy = install(mappedFixtures())
    await POST(req())
    expect((terminalLog(spy.rpcCalls)!.p_extra as Record<string, unknown>).below_floor).toBe(true)

    // The floor case still advances — that is the point of distinguishing it.
    expect((spy.writes.event_cursor ?? []).length).toBeGreaterThan(0)

    fetchMock.restore()
    fetchMock = installFetchMock(flowStubs({ v1Response: { status: 500, text: "upstream boom" } }))
    const spy2 = install(mappedFixtures())
    const res = await POST(req())
    // ⚠ Assert the ABSENCE of a cursor write, not a particular cursor value: the
    // failure mode is movement, and a value assertion passes if the write moves
    // somewhere else unexpected.
    expect(spy2.writes.event_cursor ?? []).toHaveLength(0)
    const log = terminalLog(spy2.rpcCalls)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error ?? "")).toMatch(/500/)
    // …and the logged cursor reports where it really is, not where the tick
    // intended to move it.
    expect(log.p_cursor_after).toBe(log.p_cursor_before)
    expect(res.status).toBe(500)
  })
})
