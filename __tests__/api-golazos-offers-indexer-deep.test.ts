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

// Deep-drive of POST /api/golazos-offers-indexer — the Golazos OffersV2 scanner
// that was STAGED INERT on 2026-07-28 (recon found zero Golazos offers, so no
// cron calls it). Precisely because it is inert, a bad edit would sit undetected
// until someone revives it against live money data — so it needs a structural
// pin now, not later. It is a faithful mirror of the LIVE allday-offers-indexer,
// so this ports that suite's contracts to Golazos (test-only; the route is
// untouched):
//   - EDITION-typed Golazos OfferAvailable -> golazos_open_offers upsert keyed
//     offer_id with editionId (== editions.external_id) + amount, and
//     edition_offers upsert keyed (collection_id, external_id) with
//     highest_offer = max(open amounts) — never low_ask;
//   - when an edition's last open offer clears, its edition_offers row is DELETED
//     so the Best-offer cell hides again (editions_cleared);
//   - same-tick create+complete nets to "not open" (no insert ever lands);
//   - non-Golazos nftTypes / non-EDITION params / non-positive amounts filtered;
//   - first-run backfill anchor, already-up-to-date short-circuit, fatal ->
//     honest ok=false log with no cursor advance.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// TOKEN is captured into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "gz-offers-token"

const { POST } = await import("@/app/api/golazos-offers-indexer/route")

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const GOLAZOS_NFT = "A.87ca73a41bb50ad5.Golazos.NFT"
const TS_NFT = "A.0b2a3299cc857e29.TopShot.NFT"

const OFFER_AVAILABLE = "A.b8ea91944fd51c43.OffersV2.OfferAvailable"
const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"

const address = (v: string) => ({ type: "Address", value: v })
const paramsDict = (entries: Record<string, string>) => ({
  type: "Dictionary",
  value: Object.entries(entries).map(([k, v]) => ({ key: cdc.string(k), value: cdc.string(v) })),
})

function offerPayload(opts: {
  eventType: string
  offerId: string
  amount: string
  editionId?: string
  params?: Record<string, string>
  typeID?: string
}) {
  return cdcEvent(opts.eventType, {
    offerAddress: address("0xbbbbbbbbbbbbbbbb"),
    offerId: cdc.uint64(opts.offerId),
    nftType: cdc.nftType(opts.typeID ?? GOLAZOS_NFT),
    offerAmount: cdc.ufix64(opts.amount),
    offerParamsString: paramsDict(
      opts.params ?? { _type: "EDITION", editionId: opts.editionId ?? "0" },
    ),
  })
}

// Sealed height 1250 with cursor 1000 -> exactly one 250-block chunk.
function flowRestStubs(events: {
  avail?: unknown[]
  compl?: unknown[]
  sealed?: string
  sealedStatus?: number
}): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: events.sealed ?? "1250" } }], {
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
  return new NextRequest("https://t/api/golazos-offers-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer gz-offers-token" }),
  })
}

// Request variant used to exercise the ?token= auth lane and the ?range= param.
function reqUrl(query: string, opts: { auth?: string } = {}): NextRequest {
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  return new NextRequest(`https://t/api/golazos-offers-indexer${query}`, { method: "POST", headers })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "golazos-offers-indexer")
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "gz-offers-token"
})

describe("golazos-offers-indexer — auth", () => {
  it("401s when the bearer token is missing or wrong", async () => {
    const bad = new NextRequest("https://t/api/golazos-offers-indexer", {
      method: "POST",
      headers: new Headers({ authorization: "Bearer nope" }),
    })
    const res = await POST(bad)
    expect(res.status).toBe(401)
  })
})

describe("golazos-offers-indexer — open-set ingest + highest-offer recompute", () => {
  it("two EDITION offers on one edition -> open-offer upserts + edition_offers highest_offer = max, cursor advance, ok log", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "11", amount: "5.00000000", editionId: "123" }),
          }),
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "12", amount: "9.00000000", editionId: "123" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      golazos_open_offers: [
        { error: null }, // upsert
        {
          data: [
            { edition_id: "123", amount: 5 },
            { edition_id: "123", amount: 9 },
          ],
          error: null,
        }, // recompute read
      ],
      edition_offers: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      offersSeen: 2,
      offersCompleted: 0,
      editionsWritten: 1,
      editionsCleared: 0,
      cursorBefore: "1000",
      cursorAfter: "1250",
    })

    const openUpserts = (spy.writes.golazos_open_offers ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(openUpserts).toHaveLength(2)
    expect(openUpserts.find((r) => r.offer_id === "11")).toMatchObject({ edition_id: "123", amount: 5 })
    expect(openUpserts.find((r) => r.offer_id === "12")).toMatchObject({ edition_id: "123", amount: 9 })

    const edUpserts = (spy.writes.edition_offers ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(edUpserts).toHaveLength(1)
    expect(edUpserts[0]).toMatchObject({
      collection_id: GOLAZOS,
      external_id: "123",
      highest_offer: 9,
    })
    // low_ask is never written by this indexer (preserves existing values).
    expect(Object.keys(edUpserts[0] ?? {})).not.toContain("low_ask")

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 2,
      p_rows_written: 1,
      p_collection_slug: "laliga_golazos",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    expect(log?.p_extra as Record<string, unknown>).toMatchObject({
      offers_seen: 2,
      offers_completed: 0,
      editions_written: 1,
      editions_cleared: 0,
    })
  })

  it("a completion that empties an edition's open set DELETES its edition_offers row (Best-offer cell hides)", async () => {
    const tx1 = "b".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        compl: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_COMPLETED,
            payload: offerPayload({ eventType: OFFER_COMPLETED, offerId: "21", amount: "7.00000000", editionId: "777" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      golazos_open_offers: [
        { data: [{ edition_id: "777" }], error: null }, // pre-delete edition capture
        { data: null, error: null }, // delete
        { data: [], error: null }, // recompute: nothing left open
      ],
      edition_offers: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      offersSeen: 0,
      offersCompleted: 1,
      editionsWritten: 0,
      editionsCleared: 1,
    })
    expect((spy.writes.golazos_open_offers ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    expect((spy.writes.edition_offers ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).editions_cleared).toBe(1)
  })

  it("same-tick create+complete nets to 'not open': the insert is skipped entirely", async () => {
    const tx1 = "c".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "31", amount: "4.00000000", editionId: "555" }),
          }),
        ],
        compl: [
          eventBlock({
            height: 1110,
            txId: "d".repeat(64),
            eventType: OFFER_COMPLETED,
            payload: offerPayload({ eventType: OFFER_COMPLETED, offerId: "31", amount: "4.00000000", editionId: "555" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      golazos_open_offers: [
        { data: [], error: null }, // pre-delete read (row never existed)
        { data: null, error: null }, // delete
        { data: [], error: null }, // recompute
      ],
      edition_offers: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersSeen: 1, offersCompleted: 1, editionsWritten: 0, editionsCleared: 1 })
    expect((spy.writes.golazos_open_offers ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
  })

  it("filters non-Golazos nftTypes, non-EDITION params, and non-positive amounts before any write", async () => {
    const tx1 = "e".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          // TopShot offer on the shared OffersV2 contract — filtered by nftType.
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "41", amount: "10.00000000", editionId: "1", typeID: TS_NFT }),
          }),
          // Golazos type but a serial-style (non-EDITION) param shape.
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({
              eventType: OFFER_AVAILABLE,
              offerId: "42",
              amount: "10.00000000",
              params: { _type: "NFT", nftId: "9" },
            }),
          }),
          // EDITION but zero amount.
          eventBlock({
            height: 1102,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "43", amount: "0.00000000", editionId: "2" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersSeen: 0, editionsWritten: 0, editionsCleared: 0, cursorAfter: "1250" })
    expect(spy.writes.golazos_open_offers ?? []).toHaveLength(0)
    expect(spy.writes.edition_offers ?? []).toHaveLength(0)
  })
})

describe("golazos-offers-indexer — cursor + control flow", () => {
  it("first run anchors at sealed - INITIAL_BACKFILL (floored at 0) and scans forward", async () => {
    const tx1 = "f".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        sealed: "250",
        avail: [
          eventBlock({
            height: 100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "51", amount: "2.00000000", editionId: "888" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 0 }, error: null },
      golazos_open_offers: [
        { error: null }, // upsert
        { data: [{ edition_id: "888", amount: 2 }], error: null }, // recompute
      ],
      edition_offers: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersSeen: 1, cursorBefore: "0", cursorAfter: "250" })
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 250 })
  })

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

  it("a cursor-read error logs ok=false and never advances the cursor", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({
      event_cursor: { data: null, error: { message: "cursor boom" } },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("cursor read error")
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)?.p_ok).toBe(false)
  })

  it("a sealed-height failure logs ok=false and never advances the cursor", async () => {
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

  it("authenticates via ?token= and honors an explicit ?range=", async () => {
    fetchMock = installFetchMock(flowRestStubs({}))
    const spy = install({ event_cursor: { data: { last_processed_block: 1250 }, error: null } })
    const res = await POST(reqUrl("?token=gz-offers-token&range=500"))
    expect((await res.json()).message).toBe("already up to date")
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
  })

  it("currentHeight defaults to 0 when the sealed-blocks response is empty", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", []),
      jsonRoute("OfferAvailable", []),
      jsonRoute("OfferCompleted", []),
      jsonRoute("/v1/events", []),
    ])
    install({ event_cursor: { data: { last_processed_block: 1000 }, error: null } })
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true, message: "already up to date", currentHeight: 0 })
  })

  it("an OfferAvailable events HTTP error degrades that range to empty and still advances the cursor", async () => {
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      jsonRoute("OfferAvailable", [], { status: 500 }),
      jsonRoute("OfferCompleted", []),
      jsonRoute("/v1/events", []),
    ])
    const spy = install({ event_cursor: { data: { last_processed_block: 1000 }, error: null } })
    const body = await (await POST(req())).json()
    expect(body).toMatchObject({ ok: true, offersSeen: 0, cursorAfter: "1250" })
    expect(spy.writes.event_cursor?.find((w) => w.method === "update")?.rows[0]).toMatchObject({
      last_processed_block: 1250,
    })
  })
})

describe("golazos-offers-indexer — decode edges + write-error isolation", () => {
  it("all four write errors (open upsert/delete, edition upsert/clear) are swallowed: ok=true, nothing tallied", async () => {
    const tx1 = "1".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: OFFER_AVAILABLE,
            payload: offerPayload({ eventType: OFFER_AVAILABLE, offerId: "11", amount: "9.00000000", editionId: "123" }),
          }),
        ],
        compl: [
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: OFFER_COMPLETED,
            payload: offerPayload({ eventType: OFFER_COMPLETED, offerId: "99", amount: "1.00000000", editionId: "777" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      golazos_open_offers: [
        { data: null, error: { message: "up boom" } }, // upsert error
        { data: [{ edition_id: "777" }], error: null }, // pre-delete capture
        { data: null, error: { message: "del boom" } }, // delete error
        { data: [{ edition_id: "123", amount: 9 }], error: null }, // recompute
      ],
      edition_offers: [
        { data: null, error: { message: "ed up boom" } }, // upsert error → editionsWritten stays 0
        { data: null, error: { message: "ed clear boom" } }, // clear error → editionsCleared stays 0
      ],
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      offersSeen: 1,
      offersCompleted: 1,
      editionsWritten: 0,
      editionsCleared: 0,
      cursorAfter: "1250",
    })
    expect(spy.writes.event_cursor?.find((w) => w.method === "update")).toBeTruthy()
    expect(terminalLog(spy.rpcCalls)?.p_ok).toBe(true)
  })

  it("filters a missing offerId, a missing amount (NaN), and a completion with no offerId; a string-staticType nftType still parses (Optional/Array decode)", async () => {
    const tx1 = "2".repeat(64)
    const stringStaticOffer = cdcEvent(OFFER_AVAILABLE, {
      offerAddress: address("0xbbbbbbbbbbbbbbbb"),
      offerId: cdc.uint64("51"),
      nftType: { type: "Type", value: { staticType: GOLAZOS_NFT } },
      offerAmount: cdc.ufix64("3.00000000"),
      offerParamsString: paramsDict({ _type: "EDITION", editionId: "222" }),
      optNonNull: { type: "Optional", value: cdc.string("hi") },
      optNull: cdc.optionalNull(),
      tags: { type: "Array", value: [cdc.string("a"), cdc.string("b")] },
    })
    const noOfferId = cdcEvent(OFFER_AVAILABLE, {
      nftType: cdc.nftType(GOLAZOS_NFT),
      offerAmount: cdc.ufix64("5.00000000"),
      offerParamsString: paramsDict({ _type: "EDITION", editionId: "333" }),
    })
    const noAmount = cdcEvent(OFFER_AVAILABLE, {
      offerId: cdc.uint64("52"),
      nftType: cdc.nftType(GOLAZOS_NFT),
      offerParamsString: paramsDict({ _type: "EDITION", editionId: "444" }),
    })
    const complNoOfferId = cdcEvent(OFFER_COMPLETED, {
      nftType: cdc.nftType(GOLAZOS_NFT),
      offerAmount: cdc.ufix64("2.00000000"),
      offerParamsString: paramsDict({ _type: "EDITION", editionId: "222" }),
    })
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({ height: 1100, txId: tx1, eventType: OFFER_AVAILABLE, payload: stringStaticOffer }),
          eventBlock({ height: 1101, txId: tx1, eventType: OFFER_AVAILABLE, payload: noOfferId }),
          eventBlock({ height: 1102, txId: tx1, eventType: OFFER_AVAILABLE, payload: noAmount }),
        ],
        compl: [eventBlock({ height: 1103, txId: tx1, eventType: OFFER_COMPLETED, payload: complNoOfferId })],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      golazos_open_offers: [
        { data: null, error: null }, // upsert
        { data: [{ edition_id: "222", amount: 3 }], error: null }, // recompute
      ],
      edition_offers: { data: null, error: null },
    })

    const res = await POST(req())
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, offersSeen: 1, offersCompleted: 0, editionsWritten: 1 })
    const openUpserts = (spy.writes.golazos_open_offers ?? [])
      .filter((w) => w.method === "upsert")
      .flatMap((w) => w.rows)
    expect(openUpserts).toHaveLength(1)
    expect(openUpserts[0]).toMatchObject({ offer_id: "51", edition_id: "222", amount: 3 })
  })
})

describe("golazos-offers-indexer — GET status probe", () => {
  it("returns the Golazos edition_offers count", async () => {
    install({
      edition_offers: { data: null, error: null, count: 42 },
    })
    const { GET } = await import("@/app/api/golazos-offers-indexer/route")
    const res = await GET()
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.golazosOfferRows).toBe(42)
  })

  it("500s when the count read errors", async () => {
    install({
      edition_offers: { data: null, error: { message: "count boom" } },
    })
    const { GET } = await import("@/app/api/golazos-offers-indexer/route")
    const res = await GET()
    expect(res.status).toBe(500)
  })
})
