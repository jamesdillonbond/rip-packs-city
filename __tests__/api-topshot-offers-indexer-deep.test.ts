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

// Deep-drive of POST /api/topshot-offers-indexer — the on-chain OffersV2 scanner
// that populates the rich `offers` table (synchronous route, no after()).
// Contracts pinned (test-only; the route and lib are untouched):
//   - OfferAvailable keying by offer param shape: TopShotEdition -> external
//     "setId:playId"; TopShotSubedition -> "setId:playId::subId" resolved to its
//     OWN :: editions row when cataloged (the 2026-07-07 subedition-aware
//     correctness fix), base-pair fallback when not, and subId "0" sentinel ->
//     base pair; NFT -> moments lookup giving edition + moment + true serial;
//   - the exact offers row: offer_id / tx_hash / edition_id / offer_amount_usd /
//     buyer_address / offer_type / source 'onchain' / status 'open' / created_at;
//   - same-tick create+complete is never written as open;
//   - OfferCompleted purchased -> status flip + an offer_fill SALE row keyed by
//     the FILL tx (not the creation tx), buyer/seller normalized, serial from
//     moments, plus the F1 impossible-serial parallel->base redirect;
//   - cursor advancement, already-up-to-date, fatal -> honest ok=false log.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// TOKEN is captured into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "ts-offers-token"

const { POST } = await import("@/app/api/topshot-offers-indexer/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
const OFFERER = "0xABCDEF0123456789"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"

const address = (v: string) => ({ type: "Address", value: v })
const paramsDict = (entries: Record<string, string>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({ key: cdc.string(k), value: cdc.string(v) })),
})

function offerAvailPayload(opts: {
  offerId: string
  amount: string
  params: Record<string, string>
  offerer?: string
  typeID?: string
}) {
  return cdcEvent(OFFER_AVAILABLE, {
    offerAddress: address(opts.offerer ?? OFFERER),
    offerId: cdc.uint64(opts.offerId),
    nftType: cdc.nftType(opts.typeID ?? TS_NFT),
    offerAmount: cdc.ufix64(opts.amount),
    offerParamsString: paramsDict(opts.params),
  })
}

function offerCompletedPayload(opts: {
  offerId: string
  purchased: boolean
  amount?: string
  buyer?: string
  seller?: string
  nftId?: string
  params?: Record<string, string>
  typeID?: string
}) {
  return cdcEvent(OFFER_COMPLETED, {
    purchased: cdc.bool(opts.purchased),
    acceptingAddress: opts.seller
      ? { type: "Optional", value: address(opts.seller) }
      : cdc.optionalNull(),
    offerAddress: address(opts.buyer ?? OFFERER),
    offerId: cdc.uint64(opts.offerId),
    nftType: cdc.nftType(opts.typeID ?? TS_NFT),
    offerAmount: cdc.ufix64(opts.amount ?? "1.00000000"),
    offerType: cdc.string("x"),
    offerParamsString: paramsDict(opts.params ?? {}),
    nftId: opts.nftId ? { type: "Optional", value: cdc.uint64(opts.nftId) } : cdc.optionalNull(),
  })
}

// Sealed height 1250 with cursor 1000 -> exactly one 250-block chunk.
function flowRestStubs(events: { avail?: unknown[]; compl?: unknown[]; sealedStatus?: number }): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }], {
      status: events.sealedStatus,
    }),
    jsonRoute("OfferAvailable", events.avail ?? []),
    jsonRoute("OfferCompleted", events.compl ?? []),
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
  return new NextRequest("https://t/api/topshot-offers-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ts-offers-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "topshot-offers-indexer")
    .at(-1)?.args
}

function offerUpserts(spy: ReturnType<typeof install>) {
  return (spy.writes.offers ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ts-offers-token"
})

describe("topshot-offers-indexer — OfferAvailable keying", () => {
  it("TopShotEdition offer -> offers row keyed to the setId:playId edition with the full row contract", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "501",
              amount: "55.50000000",
              params: { _type: "TopShotEdition", setId: "8", playId: "133" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      offersWritten: 1,
      byType: { edition: 1, subedition: 0, serial: 0 },
      unresolved: 0,
      cursorBefore: "1000",
      cursorAfter: "1250",
    })

    const rows = offerUpserts(spy)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      offer_id: "501",
      tx_hash: tx1,
      collection_id: TS,
      edition_id: "uuid-8133",
      moment_id: null,
      serial_number: null,
      offer_amount_usd: 55.5,
      buyer_address: OFFERER,
      offer_type: "edition",
      source: "onchain",
      status: "open",
      created_at: "2026-07-17T12:00:00Z",
    })

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_written: 1,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    expect((log?.p_extra as Record<string, unknown>).by_type).toEqual({
      edition: 1,
      subedition: 0,
      serial: 0,
    })
  })

  it("TopShotSubedition keying (the 2026-07-07 fix): cataloged ::subId wins, uncataloged falls back to base, subId 0 sentinel -> base", async () => {
    const tx1 = "b".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          // ::19 IS cataloged -> keys to its own parallel edition, NOT base.
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "601",
              amount: "21.00000000",
              params: { _type: "TopShotSubedition", setId: "233", playId: "8121", subeditionId: "19" },
            }),
          }),
          // ::21 is NOT cataloged -> resolution falls back to the base pair.
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "602",
              amount: "9.00000000",
              params: { _type: "TopShotSubedition", setId: "100", playId: "200", subeditionId: "21" },
            }),
          }),
          // subeditionId "0" is a sentinel -> keyed straight to the base pair.
          eventBlock({
            height: 1102,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "603",
              amount: "4.00000000",
              params: { _type: "TopShotSubedition", setId: "1", playId: "2", subeditionId: "0" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: {
        data: [
          { external_id: "233:8121::19", id: "uuid-sub19" },
          { external_id: "233:8121", id: "uuid-base-233" },
          { external_id: "100:200", id: "uuid-base-100" },
          { external_id: "1:2", id: "uuid-base-1" },
        ],
        error: null,
      },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersWritten: 3, byType: { subedition: 3 } })

    const rows = offerUpserts(spy)
    const byOfferId = Object.fromEntries(rows.map((r) => [r.offer_id, r]))
    // The parallel page surfaces its OWN subedition offer — never blended onto base.
    expect(byOfferId["601"]).toMatchObject({ edition_id: "uuid-sub19", offer_type: "subedition" })
    expect(byOfferId["602"]).toMatchObject({ edition_id: "uuid-base-100", offer_type: "subedition" })
    expect(byOfferId["603"]).toMatchObject({ edition_id: "uuid-base-1", offer_type: "subedition" })
  })

  it("NFT (serial) offer resolves via moments to edition + moment + true serial", async () => {
    const tx1 = "c".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "701",
              amount: "1500.00000000",
              params: { _type: "NFT", nftId: "44001122" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      moments: {
        data: [{ nft_id: "44001122", id: "mom-1", edition_id: "uuid-e7", serial_number: 7 }],
        error: null,
      },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, offersWritten: 1, byType: { serial: 1 } })

    const rows = offerUpserts(spy)
    expect(rows[0]).toMatchObject({
      offer_id: "701",
      edition_id: "uuid-e7",
      moment_id: "mom-1",
      serial_number: 7,
      offer_amount_usd: 1500,
      offer_type: "serial",
      status: "open",
    })
  })

  it("unresolvable edition offer is counted unresolved and NOT written; non-TopShot offers are filtered", async () => {
    const tx1 = "d".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "801",
              amount: "3.00000000",
              params: { _type: "TopShotEdition", setId: "9", playId: "99" },
            }),
          }),
          // AllDay offer on the shared OffersV2 contract — filtered by nftType.
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "802",
              amount: "10.00000000",
              params: { _type: "EDITION", editionId: "123" },
              typeID: ALLDAY_NFT,
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: { data: [], error: null },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersWritten: 0, unresolved: 1 })
    expect(offerUpserts(spy)).toHaveLength(0)
  })

  it("same-tick create+cancel is never written as open; the cancel flip still runs", async () => {
    const tx1 = "e".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "901",
              amount: "5.00000000",
              params: { _type: "TopShotEdition", setId: "8", playId: "133" },
            }),
          }),
        ],
        compl: [
          eventBlock({
            height: 1105,
            txId: "f".repeat(64),
            eventType: OFFER_COMPLETED,
            payload: offerCompletedPayload({ offerId: "901", purchased: false }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null },
      offers: { data: [], error: null, count: 0 } as never,
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersWritten: 0, offersCancelled: 0 })

    expect(offerUpserts(spy)).toHaveLength(0)
    const updates = (spy.writes.offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0]?.rows[0]).toMatchObject({ status: "cancelled" })
  })
})

describe("topshot-offers-indexer — fills become offer_fill sales", () => {
  it("an accepted offer flips status AND writes a sale keyed by the FILL tx with normalized buyer/seller + moments serial, then stamps fill_tx_hash", async () => {
    const fillTx = "1".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        compl: [
          eventBlock({
            height: 1100,
            txId: fillTx,
            eventType: OFFER_COMPLETED,
            payload: offerCompletedPayload({
              offerId: "501",
              purchased: true,
              amount: "25.00000000",
              buyer: "0xABCDEF0123456789",
              seller: "0xFEDCBA9876543210",
              nftId: "555",
              params: { _type: "TopShotEdition", setId: "10", playId: "20" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // 1: status flip (count 1); 2: offers-row fallback read; 3: fill_tx stamp.
      offers: [
        { error: null, count: 1 } as never,
        { data: [], error: null },
        { error: null },
      ],
      // buildOfferFillSales: 1: edByExt; 2: edIdToMeta (serial 7 <= circ, no redirect).
      editions: [
        { data: [{ external_id: "10:20", id: "uuid-ext" }], error: null },
        {
          data: [
            { id: "uuid-ext", external_id: "10:20", circulation_count: 15000 },
            { id: "uuid-e", external_id: "10:20", circulation_count: 15000 },
          ],
          error: null,
        },
      ],
      moments: { data: [{ nft_id: "555", edition_id: "uuid-e", serial_number: 7 }], error: null },
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      offersFilled: 1,
      fillsSeen: 1,
      salesWritten: 1,
      salesDuped: 0,
      salesUnresolved: 0,
    })

    // Sale row: exact-moment resolution wins (uuid-e over the ext fallback),
    // fill tx (NOT a creation tx) is the transaction_hash, addresses normalized.
    const saleInserts = (spy.writes.sales ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows)
    expect(saleInserts).toHaveLength(1)
    expect(saleInserts[0]).toMatchObject({
      edition_id: "uuid-e",
      collection_id: TS,
      collection: "nba_top_shot",
      nft_id: "555",
      price_usd: 25,
      serial_number: 7,
      sold_at: "2026-07-17T12:00:00.000Z",
      marketplace: "topshot",
      source: "offer_fill",
      block_height: 1100,
      transaction_hash: fillTx,
      buyer_address: "0xabcdef0123456789",
      seller_address: "0xfedcba9876543210",
      payer_address: null,
    })

    const updates = (spy.writes.offers ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2)
    expect(updates[0]?.rows[0]).toMatchObject({ status: "filled" })
    expect(updates[1]?.rows[0]).toEqual({ fill_tx_hash: fillTx })

    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({ offers_filled: 1, fills_seen: 1, sales_written: 1 })
  })

  it("F1 guard: an impossible serial on a ::subId parallel redirects the sale to the base edition", async () => {
    const fillTx = "2".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        compl: [
          eventBlock({
            height: 1100,
            txId: fillTx,
            eventType: OFFER_COMPLETED,
            payload: offerCompletedPayload({
              offerId: "911",
              purchased: true,
              amount: "500.00000000",
              seller: "0xFEDCBA9876543210",
              nftId: "777",
              params: { _type: "NFT", nftId: "777" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      offers: [
        { error: null, count: 0 } as never, // status flip: offer predates the indexer
        { data: [], error: null }, // fallback read
        { error: null }, // fill_tx stamp
      ],
      // Moment is F1-mis-attributed: a /50 parallel carrying serial 910.
      moments: { data: [{ nft_id: "777", edition_id: "uuid-par", serial_number: 910 }], error: null },
      editions: [
        { data: [{ id: "uuid-par", external_id: "257:8664::18", circulation_count: 50 }], error: null },
        { data: [{ id: "uuid-base", external_id: "257:8664" }], error: null },
      ],
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, salesWritten: 1 })

    const saleInserts = (spy.writes.sales ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows)
    expect(saleInserts).toHaveLength(1)
    expect(saleInserts[0]).toMatchObject({
      edition_id: "uuid-base", // redirected off the impossible parallel
      serial_number: 910,
      transaction_hash: fillTx,
      source: "offer_fill",
    })
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.sales_parallel_redirects).toBe(1)
  })
})

describe("topshot-offers-indexer — cursor + control flow", () => {
  it("already-up-to-date short-circuits with an honest log and no scan", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1250 }, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, message: "already up to date", lastBlock: 1250, currentHeight: 1250 })
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_cursor_before: "1250", p_cursor_after: "1250" })
    expect((log?.p_extra as Record<string, unknown>).message).toBe("already up to date")
  })

  it("a sealed-height failure logs ok=false, reports the error in the response, and never advances the cursor", async () => {
    fetchMock = installFetchMock(flowRestStubs({ sealedStatus: 500 }))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("blocks sealed HTTP 500")
    expect(body.cursorAfter).toBeNull()
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("blocks sealed HTTP 500")
  })

  // 🚨 THE ONE THAT LOSES DATA. `editionIdByExt` used to be built from
  // `const { data } = await …` with `error` discarded, so a failed read looked
  // like "none of these editions are cataloged": every offer fell into
  // `if (!editionId) { unresolved++; continue }`, ZERO rows were written, and the
  // cursor advanced to targetHeight anyway. Nothing revisits a block below the
  // cursor, so those offers were gone — under a run that logged ok:true with a
  // plausible `unresolved` count. Asserted as the ABSENCE of the cursor write.
  it("a failed editions read never advances the cursor and never silently drops the offers", async () => {
    const tx1 = "e".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "901",
              amount: "12.00000000",
              params: { _type: "TopShotEdition", setId: "8", playId: "133" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: { data: null, error: { message: "editions read boom" } },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("editions lookup")
    // ⛔ THE LOAD-BEARING ASSERTION: the cursor must not move, or the block is
    // never read again.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(offerUpserts(spy)).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("editions lookup")
  })

  it("401s without the token before any I/O", async () => {
    install({})
    fetchMock = installFetchMock(flowRestStubs({}))
    const res = await POST(new NextRequest("https://t/api/topshot-offers-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(fetchMock.calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A FAILED CURSOR ADVANCE IS NOT A MOVEMENT.
// `cursorAfter` was assigned immediately after an `await …from("event_cursor")
// .update(…)` whose result was discarded, so a write that supabase-js REFUSED
// still logged the new block. `cursor_before`/`cursor_after` is the only pair an
// operator can read to see a walk progressing, and it was reporting an
// unmeasured number: the next tick re-scanned the identical range while the log
// showed the indexer moving on. Twenty-one routes shared the shape; the
// structural ban lives in `event-cursor-writes-bind-their-error`, and this is
// the behavioural half on one of them.
// ─────────────────────────────────────────────────────────────────────────────
describe("topshot-offers-indexer — a failed cursor write is not reported as progress", () => {
  it("logs ok:false and leaves cursor_after unmoved when the cursor update errors", async () => {
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: "c".repeat(64),
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "777",
              amount: "10.00000000",
              params: { _type: "TopShotEdition", setId: "8", playId: "133" },
            }),
          }),
        ],
      }),
    )
    // Call 1 is the cursor READ; call 2 is the advancing UPDATE.
    const spy = install({
      event_cursor: [
        { data: { last_processed_block: 1000 }, error: null },
        { data: null, error: { message: "cursor write boom" } },
      ],
      editions: { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    const body = await res.json()

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: false })
    expect(String((log as Record<string, unknown>).p_error)).toContain("cursor advance failed")
    // ⛔ THE LOAD-BEARING ABSENCE: the run must not claim it reached the tip.
    // Before the fix this logged p_cursor_after: "1250" off a write that failed.
    expect((log as Record<string, unknown>).p_cursor_after).not.toBe("1250")
    expect(body.cursorAfter).not.toBe("1250")
    expect(body.ok).toBe(false)
  })

  it("positive control: the same fixtures WITHOUT the write error do advance to the tip", async () => {
    // Without this, the assertion above would pass for a route that never got as
    // far as the cursor at all.
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: "d".repeat(64),
            eventType: OFFER_AVAILABLE,
            payload: offerAvailPayload({
              offerId: "778",
              amount: "10.00000000",
              params: { _type: "TopShotEdition", setId: "8", playId: "133" },
            }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      editions: { data: [{ external_id: "8:133", id: "uuid-8133" }], error: null },
      offers: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: true, p_cursor_after: "1250" })
  })
})
