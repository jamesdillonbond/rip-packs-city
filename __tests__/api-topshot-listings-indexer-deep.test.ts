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

// Deep-drive of POST /api/topshot-listings-indexer — Dapper NFTStorefrontV2
// scanner filtered to TopShot.NFT. Contracts pinned (test-only):
//   - ListingAvailable -> cached_listings_v2 upsert keyed
//     (listing_resource_id, source='direct'), edition_id resolved DIRECTLY from
//     wmc.edition_key (for TopShot that key IS the editions UUID — no
//     external_id roundtrip), DUC/FUT price_usd vs FLOW null;
//   - PackNFT.NFT listings share the storefront but are SKIPPED (handled by
//     pack-events-ingest) with their own counter;
//   - unresolved nftIDs still write (edition_id NULL) — the chain event is
//     never dropped — and surface in unresolved_sample;
//   - ListingCompleted -> source-scoped completion update with
//     matched/unmatched accounting;
//   - cursor anchor on first run, already-up-to-date short-circuit, fatal
//     cursor-read -> ok=false log, auth guard.

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

// TOKEN is captured into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "ts-listings-token"

const { POST, GET } = await import("@/app/api/topshot-listings-indexer/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const PACK_NFT = "A.0b2a3299cc857e29.PackNFT.NFT"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FLOW_VAULT = "A.1654653399040a61.FlowToken.Vault"
const SELLER = "0xaaaaaaaaaaaaaaaa"

const V2_AVAIL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const V2_COMPL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"

const address = (v: string) => ({ type: "Address", value: v })
const optionalStr = (v: string) => ({ type: "Optional", value: cdc.string(v) })

function availPayload(opts: {
  nftId: string
  lrid: string
  price: string
  typeID?: string
  vaultTypeID?: string
  customID?: string
  expiry?: string
}) {
  return cdcEvent(V2_AVAIL, {
    storefrontAddress: address(SELLER),
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID ?? TS_NFT),
    nftID: cdc.uint64(opts.nftId),
    salePrice: cdc.ufix64(opts.price),
    salePaymentVaultType: cdc.nftType(opts.vaultTypeID ?? DUC_VAULT),
    customID: opts.customID ? optionalStr(opts.customID) : cdc.optionalNull(),
    expiry: opts.expiry !== undefined ? cdc.uint64(opts.expiry) : cdc.uint64("0"),
  })
}

function complPayload(opts: { lrid: string; purchased: boolean; typeID?: string }) {
  return cdcEvent(V2_COMPL, {
    listingResourceID: cdc.uint64(opts.lrid),
    storefrontResourceID: cdc.uint64(2),
    purchased: cdc.bool(opts.purchased),
    nftType: cdc.nftType(opts.typeID ?? TS_NFT),
    nftID: cdc.uint64("1"),
  })
}

// Sealed height 1250 with cursor 1000 -> exactly one 250-block chunk.
function flowRestStubs(events: { avail?: unknown[]; compl?: unknown[] }): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    jsonRoute("ListingAvailable", events.avail ?? []),
    jsonRoute("ListingCompleted", events.compl ?? []),
    jsonRoute("/v1/events", []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/topshot-listings-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ts-listings-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "topshot-listings-indexer")
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ts-listings-token"
  state.afterCbs.length = 0
})

describe("topshot-listings-indexer — ListingAvailable ingestion", () => {
  it("wmc-resolved listing -> direct upsert where wmc.edition_key IS the editions UUID; cursor advance; ok log", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: "44001122",
              lrid: "9001",
              price: "25.00000000",
              customID: "dapper-x",
              expiry: "1789000000",
            }),
          }),
        ],
      }),
    )
    const editionUuid = "0f9d3a2e-1111-4222-8333-444455556666"
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "44001122", edition_key: editionUuid }],
        error: null,
      },
      cached_listings_v2: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "9001",
      source: "direct",
      flow_id: "44001122",
      edition_id: editionUuid, // no external_id roundtrip — wmc key IS the UUID
      collection_id: TS,
      seller_address: SELLER,
      price_usd: 25,
      currency: "DUC",
      custom_id: "dapper-x",
      listed_at: "2026-07-17T12:00:00Z",
      expiry_at: new Date(1789000000 * 1000).toISOString(),
      completed_at: null,
      completed_status: null,
      block_height: 1100,
      tx_hash: tx1,
      event_index: 0,
    })

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1,
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      blocks_scanned: 250,
      listings_available_count: 1,
      pack_listings_skipped: 0,
      unresolved_sample: [],
    })
  })

  it("skips PackNFT listings (own counter), keeps FLOW listings price_usd null, and still writes unresolved rows with edition_id NULL", async () => {
    const tx1 = "b".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          // PackNFT rides the same storefront — must be skipped, not written.
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "1", lrid: "9101", price: "10.00000000", typeID: PACK_NFT }),
          }),
          // Pinnacle type on the same storefront — filtered silently.
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: "2",
              lrid: "9102",
              price: "10.00000000",
              typeID: "A.edf9df96c92f4595.Pinnacle.NFT",
            }),
          }),
          // FLOW-denominated TopShot listing with NO wmc row: row still lands,
          // edition_id null, price_usd null.
          eventBlock({
            height: 1102,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: "777888",
              lrid: "9103",
              price: "99.00000000",
              vaultTypeID: FLOW_VAULT,
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "9103",
      flow_id: "777888",
      edition_id: null,
      price_usd: null,
      currency: "FLOW",
      source: "direct",
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 1 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.events_pre_filter).toBe(3)
    expect(extra.events_post_filter).toBe(1)
    expect(extra.pack_listings_skipped).toBe(1)
    expect(extra.unresolved_sample).toEqual(["777888"])
  })
})

describe("topshot-listings-indexer — completion marking", () => {
  it("purchased/cancelled completions update source-scoped with matched/unmatched accounting; PackNFT completions ignored", async () => {
    const tx1 = "c".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        compl: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_COMPL,
            payload: complPayload({ lrid: "9001", purchased: true }),
          }),
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V2_COMPL,
            payload: complPayload({ lrid: "7777", purchased: false }),
          }),
          eventBlock({
            height: 1102,
            txId: tx1,
            eventType: V2_COMPL,
            payload: complPayload({ lrid: "5555", purchased: true, typeID: PACK_NFT }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // First completion matches an open direct row, second finds none.
      cached_listings_v2: [
        { data: [{ listing_resource_id: "9001" }], error: null },
        { data: [], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const updates = (spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2) // PackNFT completion never reached the DB
    expect(updates[0]?.rows[0]).toMatchObject({
      completed_at: "2026-07-17T12:00:00Z",
      completed_status: "purchased",
    })
    expect(updates[1]?.rows[0]).toMatchObject({ completed_status: "cancelled" })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      listings_completed_count: 2,
      completed_matched: 1,
      completed_unmatched: 1,
    })
  })
})

describe("topshot-listings-indexer — cursor + control flow", () => {
  it("first run anchors the cursor at the sealed tip without scanning events (via GET alias)", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({
      event_cursor: { data: { last_processed_block: 0 }, error: null },
    })

    const res = await GET(req())
    expect(res.status).toBe(200)
    await runDeferred()

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_cursor_before: "0", p_cursor_after: "1250" })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.message).toBe("first run, cursor anchored to sealed tip")
    expect(extra.sealed_tip).toBe(1250)
  })

  it("already-up-to-date short-circuits the scan, holds the cursor, still logs ok", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1250 }, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_cursor_before: "1250", p_cursor_after: "1250" })
    expect((log?.p_extra as Record<string, unknown>).message).toBe("already up to date")
  })

  it("a cursor-read failure logs ok=false with the error and never advances the cursor", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({
      event_cursor: { data: null, error: { message: "permission denied" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("cursor read error")
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(
      new NextRequest("https://t/api/topshot-listings-indexer", { method: "POST" }),
    )
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
