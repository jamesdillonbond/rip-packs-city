import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock, scriptResult } from "./helpers/flow-cdc-fixture"

// Deep-drive of POST /api/allday-listings-indexer — the on-chain LISTINGS twin
// of the sales indexer. Captures after() and feeds the real scan body Flow-REST
// fixtures in actual JSON-CDC encoding, so the inline unwrapCdc / extractTypeId
// / currency-derivation / edition-resolution ladder runs unmodified (test-only;
// the route is untouched). Pins the correctness contracts:
//   - V1 ListingAvailable (inline `price` + `ftVaultType`) -> cached_listings_v2
//     upsert keyed (listing_resource_id, source='direct_v1') with DUC price;
//   - V2 Dapper ListingAvailable (`salePrice`/`salePaymentVaultType`/customID/
//     expiry) -> source='direct_v2', epoch expiry -> ISO, FLOW-priced listings
//     keep price_usd NULL (USD only for DUC/FUT);
//   - ListingCompleted -> source-scoped completion update (purchased/cancelled)
//     with matched/unmatched accounting;
//   - non-AllDay nftTypes + missing storefrontAddress filtered pre-write, the
//     V2 Dapper typeid roster is surfaced for venue-shift detection;
//   - resolution ladder: wmc -> nft_edition_map -> Cadence borrow; each rung
//     pinned, and unresolvable listings land in listing_resolution_failures
//     with the exact reason. Transient/expected reasons breadcrumb but do NOT
//     page Sentry; a >25 spike of a non-transient reason DOES page;
//   - cursor anchor (first run), already-up-to-date short-circuit, cursor
//     advancement only after a real scan, and pipeline_runs logging on every
//     exit path including the fatal catch.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  breadcrumbs: [] as Array<Record<string, unknown>>,
  messages: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
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
vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: (crumb: Record<string, unknown>) => void state.breadcrumbs.push(crumb),
  captureMessage: (msg: string, ctx: Record<string, unknown>) =>
    void state.messages.push({ msg, ctx }),
}))

// TOKEN is read into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "listings-token"

const { POST, GET } = await import("@/app/api/allday-listings-indexer/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FUT_VAULT = "A.ead892083b3e2c6c.FlowUtilityToken.Vault"
const FLOW_VAULT = "A.1654653399040a61.FlowToken.Vault"
const SELLER = "0xaaaaaaaaaaaaaaaa"

const V1_AVAIL = "A.4eb8a10cb9f87357.NFTStorefront.ListingAvailable"
const V1_COMPL = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_AVAIL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const V2_DAPPER_COMPL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const V2_FLOWTY_AVAIL = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable"
const V2_FLOWTY_COMPL = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted"

// ── local JSON-CDC payload builders (Available events; the shared helper only
//    carries the sales-side Completed payloads) ─────────────────────────────
const address = (v: string) => ({ type: "Address", value: v })
const optionalStr = (v: string) => ({ type: "Optional", value: cdc.string(v) })

/** V1 Dapper ListingAvailable — full pricing inline: `price` + `ftVaultType`. */
function v1AvailPayload(opts: {
  nftId: string
  lrid: string
  price: string
  seller?: string | null
  typeID?: string
  vaultTypeID?: string
}) {
  const fields: Record<string, unknown> = {
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID ?? ALLDAY_NFT),
    nftID: cdc.uint64(opts.nftId),
    ftVaultType: cdc.nftType(opts.vaultTypeID ?? DUC_VAULT),
    price: cdc.ufix64(opts.price),
  }
  if (opts.seller !== null) fields.storefrontAddress = address(opts.seller ?? SELLER)
  return cdcEvent(V1_AVAIL, fields)
}

/** V2 ListingAvailable — `salePrice` + `salePaymentVaultType` + customID/expiry. */
function v2AvailPayload(opts: {
  nftId: string
  lrid: string
  price: string
  seller?: string
  typeID?: string
  vaultTypeID?: string
  customID?: string
  expiry?: string
  eventType?: string
}) {
  return cdcEvent(opts.eventType ?? V2_DAPPER_AVAIL, {
    storefrontAddress: address(opts.seller ?? SELLER),
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID ?? ALLDAY_NFT),
    nftID: cdc.uint64(opts.nftId),
    salePrice: cdc.ufix64(opts.price),
    salePaymentVaultType: cdc.nftType(opts.vaultTypeID ?? DUC_VAULT),
    customID: opts.customID ? optionalStr(opts.customID) : cdc.optionalNull(),
    expiry: opts.expiry !== undefined ? cdc.uint64(opts.expiry) : cdc.uint64("0"),
  })
}

/** ListingCompleted for any of the three storefronts (type filter still applies). */
function completedPayload(opts: {
  eventType: string
  lrid: string
  purchased: boolean
  typeID?: string
}) {
  return cdcEvent(opts.eventType, {
    listingResourceID: cdc.uint64(opts.lrid),
    storefrontResourceID: cdc.uint64(2),
    purchased: cdc.bool(opts.purchased),
    nftType: cdc.nftType(opts.typeID ?? ALLDAY_NFT),
    nftID: cdc.uint64("1"),
  })
}

// Flow REST stubs. Sealed height 1250 with cursor 1000 -> a single 250-block
// chunk (1001-1250), so each event fixture lands exactly once.
function flowRestStubs(events: {
  v1Avail?: unknown[]
  v1Compl?: unknown[]
  v2DapperAvail?: unknown[]
  v2DapperCompl?: unknown[]
  v2FlowtyAvail?: unknown[]
  v2FlowtyCompl?: unknown[]
  v2FlowtyAvailStatus?: number
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
    jsonRoute(V2_DAPPER_AVAIL, events.v2DapperAvail ?? []),
    jsonRoute(V2_DAPPER_COMPL, events.v2DapperCompl ?? []),
    jsonRoute(V2_FLOWTY_AVAIL, events.v2FlowtyAvail ?? [], {
      status: events.v2FlowtyAvailStatus,
    }),
    jsonRoute(V2_FLOWTY_COMPL, events.v2FlowtyCompl ?? []),
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

function req(): NextRequest {
  return new NextRequest("https://t/api/allday-listings-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer listings-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "allday-listings-indexer")
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "listings-token"
  state.afterCbs.length = 0
  state.breadcrumbs.length = 0
  state.messages.length = 0
})

describe("allday-listings-indexer — ListingAvailable ingestion", () => {
  it("V1 available -> direct_v1 upsert with inline DUC price, wmc-resolved edition, cursor advance, ok log", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "555", lrid: "9001", price: "12.50000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [{ moment_id: "555", edition_key: "321" }], error: null },
      editions: { data: [{ id: "uuid-321", external_id: "321" }], error: null },
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
      source: "direct_v1",
      flow_id: "555",
      edition_id: "uuid-321",
      collection_id: ALLDAY,
      seller_address: SELLER,
      price_usd: 12.5,
      currency: "DUC",
      custom_id: null,
      listed_at: "2026-07-17T12:00:00Z",
      completed_at: null,
      completed_status: null,
      block_height: 1100,
      tx_hash: tx1,
      event_index: 0,
    })
    // Fully resolved via wmc: no failure queued, no Cadence borrow fired.
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 1,
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_collection_slug: "nfl_all_day",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      blocks_scanned: 250,
      v1_available_count: 1,
      v2_dapper_available_count: 0,
      cadence_attempted: 0,
      cadence_resolved: 0,
      queued_failures: 0,
    })
    expect(state.messages).toHaveLength(0)
  })

  it("V2 Dapper available -> direct_v2 with salePrice, custom_id, epoch expiry -> ISO; FLOW listing keeps price_usd null", async () => {
    const tx1 = "b".repeat(64)
    const tx2 = "c".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v2DapperAvail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({
              nftId: "601",
              lrid: "9101",
              price: "30.00000000",
              vaultTypeID: FUT_VAULT,
              customID: "dapper-abc",
              expiry: "1789000000",
            }),
          }),
          eventBlock({
            height: 1101,
            txId: tx2,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({
              nftId: "602",
              lrid: "9102",
              price: "100.00000000",
              vaultTypeID: FLOW_VAULT,
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [
          { moment_id: "601", edition_key: "801" },
          { moment_id: "602", edition_key: "802" },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "uuid-801", external_id: "801" },
          { id: "uuid-802", external_id: "802" },
        ],
        error: null,
      },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const futRow = upserts.find((r) => r.flow_id === "601")
    expect(futRow).toMatchObject({
      listing_resource_id: "9101",
      source: "direct_v2",
      edition_id: "uuid-801",
      price_usd: 30,
      currency: "FUT",
      custom_id: "dapper-abc",
      expiry_at: new Date(1789000000 * 1000).toISOString(),
    })
    // FLOW is not USD-equivalent: the row lands but price_usd stays null.
    const flowRow = upserts.find((r) => r.flow_id === "602")
    expect(flowRow).toMatchObject({
      listing_resource_id: "9102",
      source: "direct_v2",
      edition_id: "uuid-802",
      price_usd: null,
      currency: "FLOW",
      expiry_at: null, // expiry 0 -> null
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 2 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.v2_dapper_available_count).toBe(2)
    // The venue-shift roster records the AllDay type seen on V2 Dapper.
    expect(extra.v2_dapper_typeids_seen).toContain(ALLDAY_NFT)
  })

  it("filters non-AllDay nftTypes + missing storefrontAddress, surfacing the V2 Dapper typeid roster", async () => {
    const tx1 = "d".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        // Pinnacle NFT on V2 Dapper (the real venue mix) — must be ignored.
        v2DapperAvail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({
              nftId: "999",
              lrid: "9103",
              price: "5.00000000",
              typeID: "A.edf9df96c92f4595.Pinnacle.NFT",
            }),
          }),
        ],
        // AllDay type but NO storefrontAddress — counted raw, then dropped.
        v1Avail: [
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "888", lrid: "9104", price: "1.00000000", seller: null }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.cached_listings_v2 ?? []).toHaveLength(0)
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.events_pre_filter).toBe(2)
    expect(extra.events_post_filter).toBe(0)
    expect(extra.v2_dapper_typeids_seen).toContain("A.edf9df96c92f4595.Pinnacle.NFT")
    // Every leg read cleanly, so this IS a complete scan and the cursor is
    // entitled to advance to the sealed tip.
    expect(log?.p_cursor_after).toBe("1250")
    expect(extra.partial_scan ?? false).toBe(false)
  })

  // ⚠ THIS TEST IS AN INVERSION, 2026-08-21. Do not "restore" it.
  //
  // It used to be the tail of the case above, and it asserted the DEFECT as
  // correct behaviour. Verbatim, the two lines that were here:
  //
  //     // The Flowty fork leg 500s this tick — fetchEventRange degrades to [].
  //     // The 500 leg did not poison the run — cursor still advanced.
  //     expect(log?.p_cursor_after).toBe("1250")
  //
  // "Did not poison the run" was exactly backwards. `fetchEventRange` swallowed
  // the non-2xx into `return []`, so the chunk read as GENUINELY EMPTY, the
  // chunk loop never recorded a failure, and the cursor advanced to 1250 over a
  // range that nothing had read. Nothing revisits a block below the cursor, so
  // every listing in those blocks was lost PERMANENTLY — behind an `ok: true`
  // run with `partial_scan` unset. The test did not miss the behaviour; it
  // pinned it, and its own comment called the loss a graceful degrade.
  //
  // Per CLAUDE.md a test that pins the defect it was named to prevent gets
  // INVERTED, never deleted: the assertion is what held the defect in place, so
  // the same fixture now has to prove the opposite. Same 500, opposite claim.
  it("a 500 on ONE storefront leg holds the cursor — it does not degrade to an empty leg", async () => {
    const tx1 = "d".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v2DapperAvail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({
              nftId: "999",
              lrid: "9103",
              price: "5.00000000",
              typeID: ALLDAY_NFT,
            }),
          }),
        ],
        // ⚠ ONE leg of three fails. That is the case that made the old
        // assertion look reasonable: the other two legs return real data, so
        // the run has something to show and reads healthy. It is still a range
        // that was never fully read.
        v2FlowtyAvailStatus: 500,
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)

    // ⚠ THE INVERTED ASSERTION. 1000 = the cursor STAYS where it was, because
    // the single chunk 1001-1250 failed. 1250 is the old, wrong answer and is
    // silent permanent loss.
    expect(
      log?.p_cursor_after,
      "a 500 on any storefront leg must hold the cursor below the failed chunk",
    ).toBe("1000")

    // And the run must SAY it was partial. A held cursor with a clean-looking
    // log is only half the fix: without the flag the short range is invisible
    // in pipeline_runs, so nobody can tell a quiet tick from a failing one.
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.partial_scan, "the run must be flagged partial").toBe(true)
    expect(extra.first_failed_chunk, "the run must name the failed chunk").toBe(1001)
  })
})

describe("allday-listings-indexer — completion marking", () => {
  it("purchased/cancelled completions update source-scoped with matched/unmatched accounting", async () => {
    const tx1 = "e".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Compl: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_COMPL,
            payload: completedPayload({ eventType: V1_COMPL, lrid: "9001", purchased: true }),
          }),
        ],
        v2FlowtyCompl: [
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V2_FLOWTY_COMPL,
            payload: completedPayload({ eventType: V2_FLOWTY_COMPL, lrid: "7777", purchased: false }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // Sequence-aware: first completion update matches an open row, second
      // finds nothing (a listing indexed before this indexer existed).
      cached_listings_v2: [
        { data: [{ listing_resource_id: "9001" }], error: null },
        { data: [], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const updates = (spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2)
    expect(updates[0]?.rows[0]).toMatchObject({
      completed_at: "2026-07-17T12:00:00Z",
      completed_status: "purchased",
    })
    expect(updates[1]?.rows[0]).toMatchObject({ completed_status: "cancelled" })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      v1_completed_count: 1,
      v2_flowty_completed_count: 1,
      completed_matched: 1,
      completed_unmatched: 1,
    })
  })
})

describe("allday-listings-indexer — edition-resolution ladder", () => {
  it("wmc miss -> nft_edition_map fallback resolves without any Cadence attempt", async () => {
    const tx1 = "f".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "710", lrid: "9201", price: "8.00000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [{ nft_id: "710", edition_external_id: "888" }], error: null },
      editions: { data: [{ id: "uuid-888", external_id: "888" }], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "710", edition_id: "uuid-888" })
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.cadence_attempted).toBe(0)
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
  })

  it("both DB sources miss -> the seller-borrow Cadence fallback resolves editionID and the listing lands", async () => {
    const tx1 = "1".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "720", lrid: "9301", price: "15.00000000" }),
          }),
        ],
        scripts: [scriptResult({ id: "720", editionID: "999", serialNumber: "3" })],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-999", external_id: "999" }], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = (spy.writes.cached_listings_v2 ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      flow_id: "720",
      edition_id: "uuid-999",
      source: "direct_v1",
      price_usd: 15,
    })
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(1)
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.cadence_attempted).toBe(1)
    expect(extra.cadence_resolved).toBe(1)
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
  })

  // ⚠ A FAILED LADDER READ IS NOT AN ABSENT MAPPING. The three lookups used to
  // discard supabase-js's `error` and fall through `?? []`, so an unread table
  // sent every listing of the tick into `listing_resolution_failures` — a queue
  // the retry drainer then works through with real Cadence borrows and a finite
  // retry budget, for rows that were never unresolvable. Asserted as the ABSENCE
  // of the queue write and of the cursor advance.
  it("a failed wmc read queues NOTHING and does not advance the cursor", async () => {
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: "f".repeat(64),
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "777", lrid: "9077", price: "5.00000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: null, error: { message: "wmc read boom" } },
      nft_edition_map: { data: [], error: null },
      editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("wallet_moments_cache lookup")
  })

  it("unresolvable (borrow nil) -> listing_resolution_failures with the transient reason; breadcrumbs but NO Sentry page", async () => {
    const tx1 = "2".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v2DapperAvail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_DAPPER_AVAIL,
            payload: v2AvailPayload({ nftId: "730", lrid: "9401", price: "3.50000000" }),
          }),
        ],
        scripts: [scriptResult(null)],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    // No listing row written for the unresolved NFT.
    const upserts = (spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "upsert")
    expect(upserts).toHaveLength(0)
    const failures = (spy.writes.listing_resolution_failures ?? []).flatMap((w) => w.rows)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      collection_id: ALLDAY,
      flow_id: "730",
      listing_resource_id: "9401",
      failure_reason: "wmc_miss_no_seller_cadence_attempt",
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.queued_failures).toBe(1)
    expect(extra.failure_reason_counts).toEqual({ wmc_miss_no_seller_cadence_attempt: 1 })
    expect(extra.unresolved_sample).toEqual(["730"])

    // Breadcrumb per queued row, but a transient/expected reason never pages.
    expect(state.breadcrumbs).toHaveLength(1)
    expect(state.breadcrumbs[0]).toMatchObject({
      category: "listing-retry",
      data: {
        collection: "nfl_all_day",
        flow_id: "730",
        failure_reason: "wmc_miss_no_seller_cadence_attempt",
      },
    })
    expect(state.messages).toHaveLength(0)
  })

  it("edition_key known but editions row missing -> edition_external_id_not_in_editions_table, no page below the spike threshold", async () => {
    const tx1 = "3".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V1_AVAIL,
            payload: v1AvailPayload({ nftId: "740", lrid: "9501", price: "2.00000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [{ moment_id: "740", edition_key: "1234" }], error: null },
      editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const failures = (spy.writes.listing_resolution_failures ?? []).flatMap((w) => w.rows)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      flow_id: "740",
      failure_reason: "edition_external_id_not_in_editions_table",
    })
    // Edition key already known -> the Cadence loop must not fire.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    // Expected (non-transient) reason at count 1 stays under the spike gate.
    expect(state.messages).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_skipped: 1 })
  })

  it("a >25 spike of a non-transient failure reason DOES page Sentry with the reason counts", async () => {
    const N = 26
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: Array.from({ length: N }, (_, i) =>
          eventBlock({
            height: 1100 + i,
            txId: "4".repeat(63) + String(i % 10),
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: String(800 + i),
              lrid: String(9600 + i),
              price: "1.00000000",
            }),
          }),
        ),
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // Every NFT has a known edition_key…
      wallet_moments_cache: {
        data: Array.from({ length: N }, (_, i) => ({
          moment_id: String(800 + i),
          edition_key: `ek-${i}`,
        })),
        error: null,
      },
      // …but none of them exist in editions: 26 non-transient failures.
      editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const failures = (spy.writes.listing_resolution_failures ?? []).flatMap((w) => w.rows)
    expect(failures).toHaveLength(N)
    expect(state.breadcrumbs).toHaveLength(N)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.msg).toBe("listing_resolution_failures_inserted")
    expect(state.messages[0]?.ctx).toMatchObject({
      level: "warning",
      tags: { collection: "nfl_all_day", indexer: "allday-listings-indexer" },
      extra: {
        queued_failures: N,
        pageable_failures: N,
        failure_reason_counts: { edition_external_id_not_in_editions_table: N },
        unexpected_reason: false,
      },
    })
    expect(terminalLog(spy.rpcCalls)).toMatchObject({
      p_rows_found: N,
      p_rows_written: 0,
      p_rows_skipped: N,
    })
  })
})

describe("allday-listings-indexer — cursor + control flow", () => {
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
      new NextRequest("https://t/api/allday-listings-indexer", { method: "POST" }),
    )
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  // Regression: a chunk whose fetch THROWS (network/timeout/parse — NOT an HTTP
  // error, which the fetch helper degrades to []) must NOT let the cursor jump to
  // targetHeight and silently skip those blocks. With one chunk (1001-1250) that
  // throws, the cursor must stay at lastBlock (1000) so the range is re-scanned.
  it("caps the cursor at lastBlock when a chunk fetch throws (no silent skip)", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      { match: (u) => u.includes("/v1/scripts"), respond: () => ({ json: scriptResult(null) }) },
      // One event-type leg throws → the chunk's Promise.all rejects → chunk catch.
      { match: (u) => u.includes(V1_AVAIL), respond: () => { throw new Error("ECONNRESET") } },
      jsonRoute(V1_COMPL, []),
      jsonRoute(V2_DAPPER_AVAIL, []),
      jsonRoute(V2_DAPPER_COMPL, []),
      jsonRoute(V2_FLOWTY_AVAIL, []),
      jsonRoute(V2_FLOWTY_COMPL, []),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      cached_listings_v2: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    // Cursor held at lastBlock — NOT advanced to targetHeight (1250).
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1000 })

    // Partial-scan signal surfaced for monitoring.
    const log = terminalLog(spy.rpcCalls)
    const extra = (log?.p_extra ?? {}) as Record<string, unknown>
    expect(extra.partial_scan).toBe(true)
    expect(extra.first_failed_chunk).toBe(1001)
    expect(extra.cursor_held_from).toBe(1250)
  })
})
