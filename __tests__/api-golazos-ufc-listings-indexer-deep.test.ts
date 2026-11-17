import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock } from "./helpers/flow-cdc-fixture"

// Deep-drive of the Golazos listings indexer (the UFC sibling and its half of this
// file were deleted 2026-10-18 with the dead UFC route code) — a lean structural sibling
// of allday-listings-indexer (same triple-storefront scan and cached_listings_v2
// keying, but NO nft_edition_map fallback, NO Cadence seller-borrow, and NO
// listing_resolution_failures queue: unresolved listings still land with
// edition_id NULL). One happy path + the wrong-collection filter each, pinning
// the per-collection constants a copy-paste drift would silently corrupt:
//   golazos: .Golazos.NFT -> collection_id 06248cc4-…, slug laliga_golazos,
//            pipeline golazos-listings-indexer, cursor id golazos_listings

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
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

process.env.INGEST_SECRET_TOKEN = "sibling-listings-token"

const golazos = await import("@/app/api/golazos-listings-indexer/route")

const GOLAZOS_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const GOLAZOS_NFT = "A.87ca73a41bb50ad5.Golazos.NFT"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FUT_VAULT = "A.ead892083b3e2c6c.FlowUtilityToken.Vault"
const SELLER = "0xbbbbbbbbbbbbbbbb"

const V1_AVAIL = "A.4eb8a10cb9f87357.NFTStorefront.ListingAvailable"
const V1_COMPL = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_AVAIL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"

const address = (v: string) => ({ type: "Address", value: v })

/** V1 Dapper ListingAvailable — inline `price` + `ftVaultType`. */
function v1AvailPayload(opts: { nftId: string; lrid: string; price: string; typeID: string }) {
  return cdcEvent(V1_AVAIL, {
    storefrontAddress: address(SELLER),
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID),
    nftID: cdc.uint64(opts.nftId),
    ftVaultType: cdc.nftType(DUC_VAULT),
    price: cdc.ufix64(opts.price),
  })
}

/** V2 Dapper ListingAvailable — `salePrice` + `salePaymentVaultType`. */
function v2AvailPayload(opts: { nftId: string; lrid: string; price: string; typeID: string }) {
  return cdcEvent(V2_DAPPER_AVAIL, {
    storefrontAddress: address(SELLER),
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID),
    nftID: cdc.uint64(opts.nftId),
    salePrice: cdc.ufix64(opts.price),
    salePaymentVaultType: cdc.nftType(FUT_VAULT),
    customID: cdc.optionalNull(),
    expiry: cdc.uint64("0"),
  })
}

function v1CompletedPayload(opts: { lrid: string; purchased: boolean; typeID: string }) {
  return cdcEvent(V1_COMPL, {
    listingResourceID: cdc.uint64(opts.lrid),
    storefrontResourceID: cdc.uint64(2),
    purchased: cdc.bool(opts.purchased),
    nftType: cdc.nftType(opts.typeID),
    nftID: cdc.uint64("1"),
  })
}

// Sealed height 1250 + cursor 1000 -> one 250-block chunk; each fixture lands once.
function flowRestStubs(events: {
  v1Avail?: unknown[]
  v1Compl?: unknown[]
  v2DapperAvail?: unknown[]
}): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    jsonRoute(V2_DAPPER_AVAIL, events.v2DapperAvail ?? []),
    jsonRoute(V1_AVAIL, events.v1Avail ?? []),
    jsonRoute(V1_COMPL, events.v1Compl ?? []),
    jsonRoute("/v1/events", []),
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
    headers: new Headers({ authorization: "Bearer sibling-listings-token" }),
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
  process.env.INGEST_SECRET_TOKEN = "sibling-listings-token"
  state.afterCbs.length = 0
})

describe("golazos-listings-indexer", () => {
  it("V1 Golazos listing -> direct_v1 row under the golazos collection id; cancellation marks the open row", async () => {
    const tx1 = "5".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "444", lrid: "5001", price: "9.99000000", typeID: GOLAZOS_NFT }),
          }),
        ],
        v1Compl: [
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V1_COMPL,
            payload: v1CompletedPayload({ lrid: "6001", purchased: false, typeID: GOLAZOS_NFT }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [{ moment_id: "444", edition_key: "55" }], error: null },
      editions: { data: [{ id: "uuid-g55", external_id: "55" }], error: null },
      // Sequence: entry 0 answers the upsert, entry 1 the completion update.
      cached_listings_v2: [
        { data: null, error: null },
        { data: [{ listing_resource_id: "6001" }], error: null },
      ],
    })

    const res = await golazos.POST(req("/api/golazos-listings-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "5001",
      source: "direct_v1",
      flow_id: "444",
      edition_id: "uuid-g55",
      collection_id: GOLAZOS_ID,
      seller_address: SELLER,
      price_usd: 9.99,
      currency: "DUC",
      block_height: 1100,
      tx_hash: tx1,
    })
    const updates = (spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0]?.rows[0]).toMatchObject({
      completed_at: "2026-07-17T12:00:00Z",
      completed_status: "cancelled",
    })

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls, "golazos-listings-indexer")
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 2,
      p_rows_written: 1,
      p_collection_slug: "laliga_golazos",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      v1_available_count: 1,
      v1_completed_count: 1,
      completed_matched: 1,
      completed_unmatched: 0,
    })
  })

  // 2026-10-19: V2 Dapper is the PRIMARY venue (route header) and this file built
  // its payload and its fetch route but never fed one through — found as an
  // unused-helper lint hit. The row must land as `direct_v2` (never `direct`,
  // Flowty's label) with the FUT sale price as USD.
  it("V2 Dapper Golazos listing -> direct_v2 row priced from salePrice (FUT = USD)", async () => {
    const tx = "7".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v2DapperAvail: [
          eventBlock({
            height: 1120,
            txId: tx,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({ nftId: "446", lrid: "5003", price: "12.50000000", typeID: GOLAZOS_NFT }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [{ moment_id: "446", edition_key: "56" }], error: null },
      editions: { data: [{ id: "uuid-g56", external_id: "56" }], error: null },
      cached_listings_v2: [{ data: null, error: null }],
    })

    const res = await golazos.POST(req("/api/golazos-listings-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "5003",
      source: "direct_v2",
      flow_id: "446",
      edition_id: "uuid-g56",
      collection_id: GOLAZOS_ID,
      seller_address: SELLER,
      price_usd: 12.5,
      currency: "FUT",
      block_height: 1120,
      tx_hash: tx,
    })
    const log = terminalLog(spy.rpcCalls, "golazos-listings-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1 })
    expect((log?.p_extra as Record<string, unknown>).v2_dapper_available_count).toBe(1)
  })

  it("ignores non-Golazos NFT types on the shared storefronts", async () => {
    const tx = "6".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "445", lrid: "5002", price: "1.00000000", typeID: "A.e4cf4bdc1751c65d.AllDay.NFT" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await golazos.POST(req("/api/golazos-listings-indexer"))
    await runDeferred()

    expect(spy.writes.cached_listings_v2 ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls, "golazos-listings-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.events_pre_filter).toBe(1)
    expect(extra.events_post_filter).toBe(0)
  })
})
