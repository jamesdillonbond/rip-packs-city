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
  v1SalePayload,
  v2DapperSalePayload,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
  V2_FLOWTY_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// The arms of the backward sales walker its deep test doesn't reach. This is
// the UFC copy; the golazos / allday / topshot-flowty siblings are structural
// twins, so a defect found here is a defect in all four.
//
//   - the **23505 row-by-row retry** on BOTH the `sales` and `unmapped_sales`
//     batch inserts. A batch .insert() is all-or-nothing, so one duplicate row
//     fails the whole ≤100-row statement; here the positive-23505 branch IS the
//     retry (the correct shape — see CLAUDE.md), and it must salvage every NEW
//     row while the genuine dupe fails alone. A non-dupe error must NOT retry.
//   - the **V2 Dapper** venue: its own purchased-only filter, its own type-suffix
//     filter, and the decode pass that fills buyer/seller (capped at 25).
//   - **?dryRun=true** — the operator lane. It must decode a sample and return
//     WITHOUT writing anything or moving the cursor; a dryRun that wrote would
//     be the worst possible bug in a backfill.
//   - **fetchEventRange**'s two non-2xx classes: a 404 "is less than" is the
//     spork FLOOR (a normal end-of-history signal, reported as belowFloor), any
//     other status is just a failed range that yields no blocks.
//   - the V1 decode BUDGET: past V1_TX_DECODE_MAX the remaining sales are
//     tagged v1_tx_decode_budget_exhausted rather than silently mispriced.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null; priceDuc?: number | null; priceCertain?: boolean; priceReason?: string; sampleAmounts?: number[] }>,
  decodeCalls: [] as Array<{ tx: string; nftId: string }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
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

process.env.INGEST_SECRET_TOKEN = "ufc-history-token"
const { POST } = await import("@/app/api/cron/ufc-sales-history-backfill/route")

const UFC_NFT = "A.329feb3ab062d289.UFC_NFT.NFT"
const CEILING = 148_500_000
const START = CEILING - 250

function flowtyPayload(nftId: string, price: string) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9200 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(UFC_NFT),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    commissionReceiver: cdc.optionalNull(),
  })
}

interface FlowEvents {
  v1?: unknown[]
  v2d?: unknown[]
  v2f?: unknown[]
  /** Override the V1 event-range response with a raw HTTP result. */
  v1Http?: { status: number; text: string }
}

function flowStubs(events: FlowEvents): FetchStub[] {
  const v1Stub: FetchStub = events.v1Http
    ? {
        match: (u) => u.includes("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"),
        respond: () => ({ status: events.v1Http!.status, text: events.v1Http!.text }),
      }
    : jsonRoute("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted", events.v1 ?? [])
  return [
    { match: (u) => u.includes("/v1/scripts"), respond: () => ({ json: { value: "" } }) },
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", events.v2f ?? []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", events.v2d ?? []),
    v1Stub,
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const req = (qs = "?range=250") =>
  new NextRequest(`https://t/api/cron/ufc-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ufc-history-token" }),
  })

const terminalLog = (rpcCalls: RecordedRpcCall[]) =>
  rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined

const cursorFixture = { data: { last_processed_block: CEILING }, error: null }

/** Two mapped UFC moments so both sales resolve to real editions. */
function mappedFixtures(over: Fixtures = {}): Fixtures {
  return {
    event_cursor: cursorFixture,
    wallet_moments_cache: {
      data: [
        { moment_id: "555", edition_key: "STRIKER-KO-500", serial_number: 12 },
        { moment_id: "777", edition_key: "GROUND-GAME-100", serial_number: 3 },
      ],
      error: null,
    },
    editions: {
      data: [
        { id: "uuid-striker", external_id: "STRIKER-KO-500" },
        { id: "uuid-ground", external_id: "GROUND-GAME-100" },
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
  process.env.INGEST_SECRET_TOKEN = "ufc-history-token"
  delete process.env.UFC_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("ufc-sales-history-backfill — batch-insert dedupe retry", () => {
  const twoFlowtySales = () =>
    flowStubs({
      v2f: [
        eventBlock({ height: CEILING - 100, txId: "a".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: flowtyPayload("555", "5.00000000") }),
        eventBlock({ height: CEILING - 101, txId: "b".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: flowtyPayload("777", "6.00000000") }),
      ],
    })

  it("retries a duplicate-poisoned sales batch row-by-row so co-batched NEW rows still land", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(
      mappedFixtures({
        sales: [
          { data: null, error: { code: "23505", message: "duplicate key value" } }, // the batch
          { data: null, error: null }, // row 1 lands
          { data: null, error: { code: "23505", message: "duplicate key value" } }, // row 2 is the real dupe
        ],
      }),
    )

    const res = await POST(req())
    expect(res.status).toBe(200)
    // 1 batch attempt + 2 single-row retries.
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(3)
    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(1) // only the genuinely-new row counted
  })

  it("does NOT retry a non-duplicate insert error", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(
      mappedFixtures({ sales: { data: null, error: { code: "23502", message: "null value in column" } } }),
    )

    await POST(req())
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(1)
    expect(terminalLog(spy.rpcCalls)!.p_rows_written).toBe(0)
  })

  it("applies the same retry to the unmapped_sales batch", async () => {
    fetchMock = installFetchMock(twoFlowtySales())
    const spy = install(
      // No wmc rows -> both sales are unmapped.
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

describe("ufc-sales-history-backfill — the V2 Dapper venue", () => {
  it("ingests a purchased V2 Dapper sale, decodes its counterparties, and filters the rest", async () => {
    const tx = "d".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0505050505050505", seller: "0x0606060606060606" }
    fetchMock = installFetchMock(
      flowStubs({
        v2d: [
          eventBlock({ height: CEILING - 50, txId: tx, eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("555", "9.00000000", UFC_NFT) }),
          // A cancellation (purchased=false) — never a sale.
          eventBlock({
            height: CEILING - 51,
            txId: "e".repeat(64),
            eventType: V2_DAPPER_LISTING_COMPLETED,
            payload: cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
              listingResourceID: cdc.uint64(1),
              storefrontResourceID: cdc.uint64(1),
              purchased: cdc.bool(false),
              nftType: cdc.nftType(UFC_NFT),
              nftID: cdc.uint64("777"),
              salePrice: cdc.ufix64("1.00000000"),
              customID: cdc.optionalNull(),
              commissionReceiver: cdc.optionalNull(),
            }),
          }),
          // Another collection on the shared storefront.
          eventBlock({ height: CEILING - 52, txId: "f".repeat(64), eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("999", "3.00000000", "A.87ca73a41bb50ad5.Golazos.NFT") }),
        ],
      }),
    )
    const spy = install(mappedFixtures())

    await POST(req())

    const rows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      nft_id: "555",
      price_usd: 9,
      buyer_address: "0x0505050505050505",
      seller_address: "0x0606060606060606",
    })
    const extra = terminalLog(spy.rpcCalls)!.p_extra as Record<string, unknown>
    expect(extra.rawV2Dapper).toBe(3)
    expect(extra.v2DapperIn).toBe(1)
  })
})

describe("ufc-sales-history-backfill — dryRun + range failures", () => {
  it("?dryRun=true decodes a sample and writes NOTHING — no sales, no unmapped, no cursor move", async () => {
    const tx = "1".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0101010101010101", seller: "0x0202020202020202", priceDuc: 30, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: CEILING - 200, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "901", true, UFC_NFT) })],
      }),
    )
    const spy = install(mappedFixtures())

    const res = await POST(req("?range=250&dryRun=true"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, mode: "dryRun", found: 1 })
    expect(body.sample[0]).toMatchObject({ src: "v1_dapper", nft: "555", price: 30, certain: true })

    // The whole point of a dry run.
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
    fetchMock = installFetchMock(flowStubs({ v1Http: { status: 404, text: "start height 100 is less than the spork root block height" } }))
    const spy = install(mappedFixtures())
    await POST(req())
    expect((terminalLog(spy.rpcCalls)!.p_extra as Record<string, unknown>).below_floor).toBe(true)

    // The floor case still advances — that is the point of distinguishing it.
    expect((spy.writes.event_cursor ?? []).length).toBeGreaterThan(0)

    fetchMock.restore()
    fetchMock = installFetchMock(flowStubs({ v1Http: { status: 500, text: "upstream boom" } }))
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
