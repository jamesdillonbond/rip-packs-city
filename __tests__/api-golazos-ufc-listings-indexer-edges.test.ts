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

// The Golazos + UFC listings indexers' CURSOR and WRITE arms — the legs the
// happy-path sibling test doesn't reach. Both routes are structural twins, so
// everything here runs as a describe.each over the pair; a copy-paste drift in
// either one's constants shows up as a single failing arm rather than silently.
//
// What actually matters here:
//   - the FIRST-RUN anchor. On a zero cursor the route must anchor to the sealed
//     tip and scan NOTHING. A regression that scanned from block 0 would walk the
//     whole chain on a fresh cursor row.
//   - the already-up-to-date short circuit, and the cursor-read failure that has
//     to log ok:false rather than silently no-op (this pipeline is watchlisted).
//   - ListingCompleted processing: matched vs unmatched, and an update error that
//     must skip ONE listing rather than abort the batch.
//   - the cached_listings_v2 batch-upsert error falling back to PER-ROW upserts,
//     so one bad row can't discard the other 99 (the batch-insert-is-all-or-
//     nothing class documented in CLAUDE.md).
//   - currency derivation: only DUC/FUT are USD-equivalent, so a FLOW- or
//     FUSD-priced listing must carry price_usd NULL rather than a raw token
//     amount rendered as dollars.
//   - the per-event decode guard (a malformed payload skips that event only) and
//     the storefrontAddress guard.

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

process.env.INGEST_SECRET_TOKEN = "listings-edge-token"

const golazos = await import("@/app/api/golazos-listings-indexer/route")
const ufc = await import("@/app/api/ufc-listings-indexer/route")

const V1_AVAIL = "A.4eb8a10cb9f87357.NFTStorefront.ListingAvailable"
const V1_COMPL = "A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"
const V2_DAPPER_AVAIL = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const SELLER = "0xbbbbbbbbbbbbbbbb"
const address = (v: string) => ({ type: "Address", value: v })

interface RouteCase {
  label: string
  mod: { POST: (r: NextRequest) => Promise<Response>; GET: (r: NextRequest) => Promise<Response> }
  path: string
  pipeline: string
  slug: string
  collectionId: string
  nftType: string
  cursorId: string
}

const ROUTES: RouteCase[] = [
  {
    label: "golazos",
    mod: golazos,
    path: "/api/golazos-listings-indexer",
    pipeline: "golazos-listings-indexer",
    slug: "laliga_golazos",
    collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
    nftType: "A.87ca73a41bb50ad5.Golazos.NFT",
    cursorId: "golazos_listings",
  },
  {
    label: "ufc",
    mod: ufc,
    path: "/api/ufc-listings-indexer",
    pipeline: "ufc-listings-indexer",
    slug: "ufc_strike",
    collectionId: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
    nftType: "A.329feb3ab062d289.UFC_NFT.NFT",
    cursorId: "ufc_listings",
  },
]

function v1AvailPayload(o: { nftId: string; lrid: string; price: string; typeID: string; vault: string; seller?: unknown }) {
  return cdcEvent(V1_AVAIL, {
    storefrontAddress: o.seller ?? address(SELLER),
    listingResourceID: cdc.uint64(o.lrid),
    nftType: cdc.nftType(o.typeID),
    nftID: cdc.uint64(o.nftId),
    ftVaultType: cdc.nftType(o.vault),
    price: cdc.ufix64(o.price),
  })
}

function v1CompletedPayload(o: { lrid: string; purchased: boolean; typeID: string }) {
  return cdcEvent(V1_COMPL, {
    listingResourceID: cdc.uint64(o.lrid),
    storefrontResourceID: cdc.uint64(2),
    purchased: cdc.bool(o.purchased),
    nftType: cdc.nftType(o.typeID),
    nftID: cdc.uint64("1"),
  })
}

/** Sealed tip 1250; with cursor 1000 that is one 250-block chunk. */
function flowRestStubs(
  events: { v1Avail?: unknown[]; v1Compl?: unknown[] } = {},
  opts: { sealed?: unknown; sealedStatus?: number } = {},
): FetchStub[] {
  const sealed = opts.sealedStatus
    ? { match: (u: string) => u.includes("blocks?height=sealed"), respond: () => ({ status: opts.sealedStatus, text: "no" }) }
    : jsonRoute("blocks?height=sealed", opts.sealed ?? [{ header: { height: "1250" } }])
  return [
    sealed as FetchStub,
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

function req(path: string, qs = ""): NextRequest {
  return new NextRequest(`https://t${path}${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer listings-edge-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline).at(-1)
    ?.args as Record<string, unknown> | undefined
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  state.afterCbs.length = 0
})

describe.each(ROUTES)("$label-listings-indexer — cursor arms", (R) => {
  it("anchors a zero cursor to the sealed tip and scans nothing", async () => {
    const spy = install({
      event_cursor: { data: { last_processed_block: 0 }, error: null },
    })
    fetchMock = installFetchMock(flowRestStubs())

    await R.mod.POST(req(R.path))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, R.pipeline)!
    expect(log.p_ok).toBe(true)
    expect(log.p_cursor_before).toBe("0")
    expect(log.p_cursor_after).toBe("1250")
    expect((log.p_extra as Record<string, unknown>).message).toBe("first run, cursor anchored to sealed tip")
    // Only the sealed-tip probe ran — no event range was walked.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect((spy.writes.event_cursor ?? []).flatMap((w) => w.rows)[0]).toMatchObject({
      last_processed_block: 1250,
    })
  })

  it("short-circuits when the cursor is already at or past the sealed tip", async () => {
    const spy = install({ event_cursor: { data: { last_processed_block: 9999 }, error: null } })
    fetchMock = installFetchMock(flowRestStubs())

    await R.mod.POST(req(R.path))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, R.pipeline)!
    expect((log.p_extra as Record<string, unknown>).message).toBe("already up to date")
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
  })

  it("logs ok:false when the cursor row cannot be read", async () => {
    const spy = install({ event_cursor: { data: null, error: { message: "cursor gone" } } })
    fetchMock = installFetchMock(flowRestStubs())

    await R.mod.POST(req(R.path))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, R.pipeline)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("cursor gone")
    expect(log.p_collection_slug).toBe(R.slug)
  })

  it("logs ok:false when the sealed-height probe fails", async () => {
    const spy = install({ event_cursor: { data: { last_processed_block: 1000 }, error: null } })
    fetchMock = installFetchMock(flowRestStubs({}, { sealedStatus: 500 }))

    await R.mod.POST(req(R.path))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, R.pipeline)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("blocks sealed HTTP 500")
  })

  it("GET is an alias for POST and both 401 without the token", async () => {
    install({ event_cursor: { data: { last_processed_block: 9999 }, error: null } })
    fetchMock = installFetchMock(flowRestStubs())
    expect((await R.mod.GET(req(R.path))).status).toBe(200)
    await runDeferred()

    const anon = new NextRequest(`https://t${R.path}`, { method: "POST" })
    expect((await R.mod.POST(anon)).status).toBe(401)
  })
})

describe.each(ROUTES)("$label-listings-indexer — write arms", (R) => {
  /** Cursor 1000 -> one chunk; caller supplies the V1 event blocks. */
  function base(fixtures: Fixtures): Fixtures {
    return {
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
      ...fixtures,
    }
  }

  it("falls back to per-row upserts when the batch write fails, so one bad row cannot discard the rest", async () => {
    const spy = install(
      base({
        cached_listings_v2: [
          { data: null, error: { message: "batch rejected" } }, // the ≤100-row batch
          { data: null, error: null }, // per-row retry: row 1 lands
          { data: null, error: { message: "row 2 bad" } }, // per-row retry: row 2 skipped
        ],
      }),
    )
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1001,
            txId: "tx1",
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "1",
              lrid: "10",
              price: "5.0",
              typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
            }),
          }),
          eventBlock({
            height: 1002,
            txId: "tx2",
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "2",
              lrid: "11",
              price: "6.0",
              typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
            }),
          }),
        ],
      }),
    )

    await R.mod.POST(req(R.path))
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, R.pipeline)!
    expect(log.p_rows_found).toBe(2)
    expect(log.p_rows_written).toBe(1)
    expect(log.p_rows_skipped).toBe(1)
    // 1 batch attempt + 2 per-row retries.
    expect((spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "upsert")).toHaveLength(3)
  })

  it("marks only USD-equivalent vaults with a price_usd", async () => {
    const spy = install(base({}))
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1001,
            txId: "tx1",
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "1", lrid: "10", price: "5.0", typeID: R.nftType,
              vault: "A.1654653399040a61.FlowToken.Vault",
            }),
          }),
          eventBlock({
            height: 1002,
            txId: "tx2",
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "2", lrid: "11", price: "6.0", typeID: R.nftType,
              vault: "A.3c5959b568896393.FUSD.Vault",
            }),
          }),
          eventBlock({
            height: 1003,
            txId: "tx3",
            eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "3", lrid: "12", price: "7.0", typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.FlowUtilityToken.Vault",
            }),
          }),
        ],
      }),
    )

    await R.mod.POST(req(R.path))
    await runDeferred()

    const rows = (spy.writes.cached_listings_v2 ?? []).flatMap((w) => w.rows)
    const byLrid = Object.fromEntries(rows.map((r) => [r.listing_resource_id, r]))
    expect(byLrid["10"]).toMatchObject({ currency: "FLOW", price_usd: null })
    expect(byLrid["11"]).toMatchObject({ currency: "FUSD", price_usd: null })
    expect(byLrid["12"]).toMatchObject({ currency: "FUT", price_usd: 7 })
    // Every row is keyed to this route's own collection + the V1 source.
    for (const r of rows) {
      expect(r.collection_id).toBe(R.collectionId)
      expect(r.source).toBe("direct_v1")
      expect(r.seller_address).toBe(SELLER)
    }
  })

  it("resolves edition_id through wmc -> editions and samples the ones it cannot", async () => {
    const spy = install(
      base({
        wallet_moments_cache: { data: [{ moment_id: "1", edition_key: "ek-1" }], error: null },
        editions: { data: [{ id: "uuid-1", external_id: "ek-1" }], error: null },
      }),
    )
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          eventBlock({
            height: 1001, txId: "tx1", eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "1", lrid: "10", price: "5.0", typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
            }),
          }),
          eventBlock({
            height: 1002, txId: "tx2", eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "99", lrid: "11", price: "5.0", typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
            }),
          }),
        ],
      }),
    )

    await R.mod.POST(req(R.path))
    await runDeferred()

    const rows = (spy.writes.cached_listings_v2 ?? []).flatMap((w) => w.rows)
    expect(rows.find((r) => r.listing_resource_id === "10")?.edition_id).toBe("uuid-1")
    // Unresolved listings still land (no failure queue on these siblings).
    expect(rows.find((r) => r.listing_resource_id === "11")?.edition_id).toBeNull()
    const extra = terminalLog(spy.rpcCalls, R.pipeline)!.p_extra as Record<string, unknown>
    expect(extra.unresolved_sample).toEqual(["99"])
  })

  it("counts matched vs unmatched completions and skips one whose update errors", async () => {
    const spy = install(
      base({
        cached_listings_v2: [
          { data: [{ listing_resource_id: "10" }], error: null }, // matched
          { data: [], error: null }, // no open row
          { data: null, error: { message: "update blew up" } }, // error -> skipped entirely
        ],
      }),
    )
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Compl: [
          eventBlock({ height: 1001, txId: "t1", eventType: V1_COMPL, payload: v1CompletedPayload({ lrid: "10", purchased: true, typeID: R.nftType }) }),
          eventBlock({ height: 1002, txId: "t2", eventType: V1_COMPL, payload: v1CompletedPayload({ lrid: "11", purchased: false, typeID: R.nftType }) }),
          eventBlock({ height: 1003, txId: "t3", eventType: V1_COMPL, payload: v1CompletedPayload({ lrid: "12", purchased: true, typeID: R.nftType }) }),
        ],
      }),
    )

    await R.mod.POST(req(R.path))
    await runDeferred()

    const extra = terminalLog(spy.rpcCalls, R.pipeline)!.p_extra as Record<string, unknown>
    expect(extra.v1_completed_count).toBe(3)
    expect(extra.completed_matched).toBe(1)
    // The unmatched one AND the errored one are both absent from `matched`; only
    // the unmatched is counted as skipped (an error must not be a silent match).
    expect(extra.completed_unmatched).toBe(1)

    const updates = (spy.writes.cached_listings_v2 ?? []).filter((w) => w.method === "update")
    expect(updates[0].rows[0]).toMatchObject({ completed_status: "purchased" })
    expect(updates[1].rows[0]).toMatchObject({ completed_status: "cancelled" })
  })

  it("skips a malformed payload and an event with no storefront address, keeping the good one", async () => {
    const spy = install(base({}))
    const badBlock = {
      block_id: "b".repeat(64),
      block_height: "1001",
      block_timestamp: "2026-07-17T12:00:00Z",
      events: [{ type: V1_AVAIL, transaction_id: "bad", event_index: 0, payload: "!!!not-base64-json!!!" }],
    }
    fetchMock = installFetchMock(
      flowRestStubs({
        v1Avail: [
          badBlock,
          eventBlock({
            height: 1002, txId: "tx2", eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "2", lrid: "11", price: "6.0", typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
              seller: cdc.optionalNull(), // no storefrontAddress -> dropped
            }),
          }),
          eventBlock({
            height: 1003, txId: "tx3", eventType: V1_AVAIL,
            payload: v1AvailPayload({
              nftId: "3", lrid: "12", price: "7.0", typeID: R.nftType,
              vault: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
            }),
          }),
        ],
      }),
    )

    await R.mod.POST(req(R.path))
    await runDeferred()

    const rows = (spy.writes.cached_listings_v2 ?? []).flatMap((w) => w.rows)
    expect(rows.map((r) => r.listing_resource_id)).toEqual(["12"])
    const extra = terminalLog(spy.rpcCalls, R.pipeline)!.p_extra as Record<string, unknown>
    expect(extra.events_pre_filter).toBe(3) // all three were seen…
    expect(extra.events_post_filter).toBe(1) // …only one survived
  })

  it("walks multiple chunks when the requested range spans more than one", async () => {
    const spy = install(
      base({ event_cursor: { data: { last_processed_block: 500 }, error: null } }),
    )
    fetchMock = installFetchMock(flowRestStubs())

    // sealed tip 1250 - cursor 500 = 750 blocks -> three 250-block chunks,
    // six event types each.
    await R.mod.POST(req(R.path, "?range=1000"))
    await runDeferred()

    const eventCalls = fetchMock.calls.filter((c) => c.url.includes("/v1/events"))
    expect(eventCalls).toHaveLength(18)
    const extra = terminalLog(spy.rpcCalls, R.pipeline)!.p_extra as Record<string, unknown>
    expect(extra.blocks_scanned).toBe(750)
  })
})
