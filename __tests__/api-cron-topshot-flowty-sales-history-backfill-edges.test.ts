import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock, V2_FLOWTY_LISTING_COMPLETED } from "./helpers/flow-cdc-fixture"

// The fourth backward walker's share of the family edges suite (the UFC /
// AllDay / Golazos copies live alongside). Same two shapes, on the Flowty-fork
// single-source walker:
//
//   - the 23505 row-by-row retry on BOTH the `sales` and `unmapped_sales` batch
//     inserts. A batch .insert() is all-or-nothing, so one duplicate fails the
//     whole ≤100-row statement; the positive-23505 branch IS the retry here (the
//     correct shape per CLAUDE.md) and must salvage every co-batched NEW row,
//     while a non-dupe error must NOT retry.
//   - fetchEventRange's two non-2xx classes: a 404 whose body says "is less
//     than" is the spork FLOOR (a normal end-of-history signal, surfaced as
//     below_floor), while any other failing status is just an empty range — the
//     run must stay ok:true with 0 rows rather than claim a floor it never hit.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeTopShotSaleTx: async (tx: string) => {
    const d = state.decodeByTx[tx] ?? {}
    return { buyer: d.buyer ?? null, seller: d.seller ?? null, payer: null, proposer: null, ok: true }
  },
}))

process.env.INGEST_SECRET_TOKEN = "flowty-history-token"
const { POST } = await import("@/app/api/cron/topshot-flowty-sales-history-backfill/route")

const TOPSHOT_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const SPORK_FLOOR = 137_390_146
const CEILING = 149_000_000
const PROXY = "https://ts-proxy.test/graphql"

function flowtySale(nftId: string, price: string, txId: string, height: number) {
  return eventBlock({
    height,
    txId,
    eventType: V2_FLOWTY_LISTING_COMPLETED,
    payload: cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
      listingResourceID: cdc.uint64(9300 + (Number(nftId) % 1000)),
      storefrontResourceID: cdc.uint64(3),
      purchased: cdc.bool(true),
      nftType: cdc.nftType(TOPSHOT_NFT),
      nftID: cdc.uint64(nftId),
      salePrice: cdc.ufix64(price),
      customID: cdc.optionalNull(),
    }),
  })
}

function flowStubs(opts: { events?: unknown[]; eventsHttp?: { status: number; text: string } }): FetchStub[] {
  return [
    // getMintedMoment: nothing resolvable, so wmc is the only resolution path.
    { match: (u) => u.includes("ts-proxy.test"), respond: () => ({ json: { data: { getMintedMoment: { data: null } } } }) },
    { match: (u) => u.includes("/v1/blocks?height=sealed"), respond: () => ({ json: [{ header: { height: String(SPORK_FLOOR + 1) } }] }) },
    jsonRoute("/v1/blocks?height=", [{ header: { timestamp: "2026-05-01T00:00:00Z" } }]),
    opts.eventsHttp
      ? {
          match: (u) => u.includes("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"),
          respond: () => ({ status: opts.eventsHttp!.status, ok: false, text: opts.eventsHttp!.text }),
        }
      : jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", opts.events ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const req = (qs = "?range=250") =>
  new NextRequest(`https://t/api/cron/topshot-flowty-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer flowty-history-token" }),
  })

const terminalLog = (rpcCalls: RecordedRpcCall[]) =>
  rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined

/** wmc carries CANONICAL "setID:playID" keys so both sales resolve. */
function mappedFixtures(over: Fixtures = {}): Fixtures {
  return {
    event_cursor: { data: { last_processed_block: CEILING }, error: null },
    wallet_moments_cache: {
      data: [
        { moment_id: "555", edition_key: "3:45", serial_number: 12 },
        { moment_id: "777", edition_key: "3:46", serial_number: 3 },
      ],
      error: null,
    },
    nft_edition_map: { data: [], error: null },
    editions: {
      data: [
        { id: "uuid-ts-1", external_id: "3:45" },
        { id: "uuid-ts-2", external_id: "3:46" },
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
  process.env.INGEST_SECRET_TOKEN = "flowty-history-token"
  process.env.TS_PROXY_URL = PROXY
  delete process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
})

describe("topshot-flowty-sales-history-backfill — batch-insert dedupe retry", () => {
  const twoSales = () =>
    flowStubs({
      events: [
        flowtySale("555", "5.00000000", "a".repeat(64), CEILING - 100),
        flowtySale("777", "6.00000000", "b".repeat(64), CEILING - 101),
      ],
    })

  it("retries a duplicate-poisoned sales batch row-by-row so co-batched NEW rows still land", async () => {
    fetchMock = installFetchMock(twoSales())
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
    fetchMock = installFetchMock(twoSales())
    const spy = install(mappedFixtures({ sales: { data: null, error: { code: "23502", message: "null value in column" } } }))

    await POST(req())
    expect((spy.writes.sales ?? []).filter((w) => w.method === "insert")).toHaveLength(1)
    expect(terminalLog(spy.rpcCalls)!.p_rows_written).toBe(0)
  })

  it("applies the same retry to the unmapped_sales batch", async () => {
    fetchMock = installFetchMock(twoSales())
    const spy = install(
      // No wmc / map rows and an unresolvable getMinted -> both land unmapped.
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

describe("topshot-flowty-sales-history-backfill — event-range failures", () => {
  it("reports below_floor on the spork-floor 404 and treats any other status as an empty range", async () => {
    fetchMock = installFetchMock(flowStubs({ eventsHttp: { status: 404, text: "start height 1 is less than the spork root block height" } }))
    const spy = install(mappedFixtures())
    await POST(req())
    expect((terminalLog(spy.rpcCalls)!.p_extra as Record<string, unknown>).below_floor).toBe(true)

    fetchMock.restore()
    fetchMock = installFetchMock(flowStubs({ eventsHttp: { status: 500, text: "upstream boom" } }))
    const spy2 = install(mappedFixtures())
    expect((await POST(req())).status).toBe(200)
    const log = terminalLog(spy2.rpcCalls)!
    expect((log.p_extra as Record<string, unknown>).below_floor).toBe(false)
    expect(log.p_rows_found).toBe(0)
    expect(log.p_ok).toBe(true)
  })
})
