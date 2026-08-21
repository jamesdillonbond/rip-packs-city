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

// Deep-drive of POST /api/pinnacle-listings-indexer — the Pinnacle twin of the
// AllDay listings indexer, with three Pinnacle-specific contracts this suite
// pins (test-only; the route is untouched):
//   - "resolved" means the derived edition_key is KNOWN in pinnacle_editions
//     (or, rarely, editions) — the editions UUID is a bonus that is almost
//     always NULL for Pinnacle and is NOT the resolution criterion (the 2026-06
//     fix; the old `!editionUuid` gate re-queued every pinnacle_editions-only
//     edition every tick and fired per-tick Sentry noise);
//   - EVERY ListingAvailable writes a cached_listings_v2 row keyed
//     (listing_resource_id, source='direct') even when unresolved — unlike
//     AllDay, which withholds the row;
//   - the Sentry gate counts only genuinely-NEW failure inserts (the rows the
//     ignoreDuplicates upsert actually RETURNS), pages on a >100 spike or a
//     never-before-seen reason, and stays silent on the expected permanent tail.
// Plus the shared indexer spine: DUC/FUT USD-equivalence vs FLOW null price,
// epoch expiry -> ISO, pinnacle_nft_map -> wmc -> Cadence-borrow resolution
// ladder with the 12-attempt cap, completion matching, cursor semantics, and
// pipeline_runs logging on every exit path.

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

// TOKEN is captured into a module const at import time.
process.env.INGEST_SECRET_TOKEN = "pinnacle-token"

const { POST, GET } = await import("@/app/api/pinnacle-listings-indexer/route")

const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const PINNACLE_NFT = "A.edf9df96c92f4595.Pinnacle.NFT"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FUT_VAULT = "A.ead892083b3e2c6c.FlowUtilityToken.Vault"
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
    nftType: cdc.nftType(opts.typeID ?? PINNACLE_NFT),
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
    nftType: cdc.nftType(opts.typeID ?? PINNACLE_NFT),
    nftID: cdc.uint64("1"),
  })
}

// Sealed height 1250 with cursor 1000 -> exactly one 250-block chunk, so each
// event fixture lands exactly once.
function flowRestStubs(events: {
  avail?: unknown[]
  compl?: unknown[]
  scripts?: Array<{ value: string }>
  eventsHttp?: { status: number; text: string }
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
    ...(events.eventsHttp
      ? [
          {
            match: (url: string) => url.includes("/v1/events"),
            respond: () => ({ status: events.eventsHttp!.status, ok: false, text: events.eventsHttp!.text }),
          },
        ]
      : [
          jsonRoute("ListingAvailable", events.avail ?? []),
          jsonRoute("ListingCompleted", events.compl ?? []),
          jsonRoute("/v1/events", []),
        ]),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/pinnacle-listings-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer pinnacle-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === "pinnacle-listings-indexer")
    .at(-1)?.args
}

function v2Upserts(spy: ReturnType<typeof install>) {
  return (spy.writes.cached_listings_v2 ?? [])
    .filter((w) => w.method === "upsert")
    .flatMap((w) => w.rows)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "pinnacle-token"
  state.afterCbs.length = 0
  state.breadcrumbs.length = 0
  state.messages.length = 0
})

describe("pinnacle-listings-indexer — ListingAvailable ingestion + resolution semantics", () => {
  it("nft_map-resolved listing with an editions UUID -> direct row with edition_id, DUC price, cursor advance, ok log", async () => {
    const tx1 = "a".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "555", lrid: "9001", price: "12.50000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [{ nft_id: "555", edition_key: "RC1:Standard:1" }], error: null },
      editions: { data: [{ id: "uuid-pe1", external_id: "RC1:Standard:1" }], error: null },
      pinnacle_editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, message: "indexing started" })
    await runDeferred()

    const upserts = v2Upserts(spy)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "9001",
      source: "direct",
      flow_id: "555",
      edition_id: "uuid-pe1",
      collection_id: PINNACLE,
      seller_address: SELLER,
      price_usd: 12.5,
      currency: "DUC",
      custom_id: null,
      listed_at: "2026-07-17T12:00:00Z",
      expiry_at: null, // expiry 0 -> null
      completed_at: null,
      completed_status: null,
      block_height: 1100,
      tx_hash: tx1,
      event_index: 0,
    })
    // Fully resolved: no failure queued, no Cadence borrow fired.
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
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: "1000",
      p_cursor_after: "1250",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      blocks_scanned: 250,
      listings_available_count: 1,
      listings_completed_count: 0,
      unresolved_edition_count: 0,
      cadence_attempted: 0,
      cadence_resolved: 0,
      queued_failures: 0,
    })
    expect(extra.failure_reason_counts).toEqual({})
    expect(state.messages).toHaveLength(0)
  })

  it("pinnacle_editions-only edition_key counts as RESOLVED: row lands with edition_id NULL and NO failure is queued (the misclassification fix)", async () => {
    const tx1 = "b".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "556", lrid: "9002", price: "40.00000000" }),
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [{ nft_id: "556", edition_key: "RC2:Chaser:2" }], error: null },
      // No editions UUID for this key — but pinnacle_editions KNOWS it.
      editions: { data: [], error: null },
      pinnacle_editions: { data: [{ edition_key: "RC2:Chaser:2" }], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = v2Upserts(spy)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "556", edition_id: null, price_usd: 40 })
    // The whole point of the fix: known-in-pinnacle_editions is NOT a failure.
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.unresolved_edition_count).toBe(0)
    expect(extra.queued_failures).toBe(0)
    expect(state.breadcrumbs).toHaveLength(0)
    expect(state.messages).toHaveLength(0)
  })

  it("nft_map miss -> wmc fallback resolves; FUT is USD-equivalent, FLOW keeps price_usd null, epoch expiry -> ISO", async () => {
    const tx1 = "c".repeat(64)
    const tx2 = "d".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: "601",
              lrid: "9101",
              price: "30.00000000",
              vaultTypeID: FUT_VAULT,
              customID: "pin-abc",
              expiry: "1789000000",
            }),
          }),
          eventBlock({
            height: 1101,
            txId: tx2,
            eventType: V2_AVAIL,
            payload: availPayload({
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
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: {
        data: [
          { moment_id: "601", edition_key: "RC3:Standard:3" },
          { moment_id: "602", edition_key: "RC4:Standard:4" },
        ],
        error: null,
      },
      editions: { data: [], error: null },
      pinnacle_editions: {
        data: [{ edition_key: "RC3:Standard:3" }, { edition_key: "RC4:Standard:4" }],
        error: null,
      },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = v2Upserts(spy)
    expect(upserts).toHaveLength(2)
    const futRow = upserts.find((r) => r.flow_id === "601")
    expect(futRow).toMatchObject({
      listing_resource_id: "9101",
      price_usd: 30,
      currency: "FUT",
      custom_id: "pin-abc",
      expiry_at: new Date(1789000000 * 1000).toISOString(),
    })
    const flowRow = upserts.find((r) => r.flow_id === "602")
    expect(flowRow).toMatchObject({
      listing_resource_id: "9102",
      price_usd: null,
      currency: "FLOW",
      expiry_at: null,
    })
    // wmc closed the gap — no Cadence attempt, nothing queued.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_ok: true, p_rows_found: 2, p_rows_written: 2 })
  })

  it("both DB maps miss -> seller-borrow Cadence fallback composes the edition_key from traits and resolves", async () => {
    const tx1 = "e".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "700", lrid: "9201", price: "8.00000000" }),
          }),
        ],
        scripts: [scriptResult({ editionKey: "RCX:Standard:9", serialNumber: "3" })],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
      pinnacle_editions: { data: [{ edition_key: "RCX:Standard:9" }], error: null },
      cached_listings_v2: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    const upserts = v2Upserts(spy)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ flow_id: "700", edition_id: null, price_usd: 8 })
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(1)
    expect(spy.writes.listing_resolution_failures ?? []).toHaveLength(0)
    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.cadence_attempted).toBe(1)
    expect(extra.cadence_resolved).toBe(1)
    expect(extra.unresolved_edition_count).toBe(0)
  })

  it("unresolvable (borrow nil) STILL writes the v2 row (edition_id null) AND queues the failure — breadcrumb, no page", async () => {
    const tx1 = "f".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "730", lrid: "9401", price: "3.50000000" }),
          }),
        ],
        scripts: [scriptResult(null)],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
      // ignoreDuplicates upsert + .select() returns only the genuinely-new rows.
      listing_resolution_failures: {
        data: [{ listing_resource_id: "9401", flow_id: "730", failure_reason: "cadence_borrow_failed" }],
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    // Pinnacle contract: unresolved listings are NOT withheld (unlike AllDay).
    const upserts = v2Upserts(spy)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      listing_resource_id: "9401",
      flow_id: "730",
      edition_id: null,
      price_usd: 3.5,
    })
    const failures = (spy.writes.listing_resolution_failures ?? []).flatMap((w) => w.rows)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      collection_id: PINNACLE,
      flow_id: "730",
      listing_resource_id: "9401",
      failure_reason: "cadence_borrow_failed",
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 1 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra).toMatchObject({
      unresolved_edition_count: 1,
      unresolved_sample: ["730"],
      queued_failures: 1,
      failure_reason_counts: { cadence_borrow_failed: 1 },
      cadence_attempted: 1,
      cadence_resolved: 0,
    })
    // Breadcrumb per new failure row; expected reason at count 1 never pages.
    expect(state.breadcrumbs).toHaveLength(1)
    expect(state.breadcrumbs[0]).toMatchObject({
      category: "listing-retry",
      data: { collection: "disney_pinnacle", flow_id: "730", failure_reason: "cadence_borrow_failed" },
    })
    expect(state.messages).toHaveLength(0)
  })

  it("caps live-ingest Cadence at 12 attempts; overflow classifies as cadence_capped, attempted ones as cadence_borrow_failed", async () => {
    const N = 13
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: Array.from({ length: N }, (_, i) =>
          eventBlock({
            height: 1100 + i,
            txId: "1".repeat(63) + String(i % 10),
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: String(800 + i),
              lrid: String(9500 + i),
              price: "1.00000000",
            }),
          }),
        ),
        scripts: [scriptResult(null)],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
      listing_resolution_failures: { data: [], error: null },
    })

    await POST(req())
    await runDeferred()

    // Exactly CADENCE_FALLBACK_MAX borrows fired.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(12)

    const failures = (spy.writes.listing_resolution_failures ?? []).flatMap((w) => w.rows)
    expect(failures).toHaveLength(N)
    const reasons = failures.reduce<Record<string, number>>((acc, r) => {
      const k = String(r.failure_reason)
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})
    expect(reasons).toEqual({ cadence_borrow_failed: 12, cadence_capped: 1 })
    // The 13th event (never attempted) is the capped one.
    expect(failures.find((r) => r.failure_reason === "cadence_capped")?.flow_id).toBe("812")

    const extra = terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra.cadence_attempted).toBe(12)
    expect(extra.unresolved_edition_count).toBe(N)
    // All 13 listings still landed as rows.
    expect(v2Upserts(spy)).toHaveLength(N)
    // The DB reported 0 NEW inserts (steady-state backlog re-seen) -> no
    // breadcrumbs, no page — re-observation is not a spike.
    expect(state.breadcrumbs).toHaveLength(0)
    expect(state.messages).toHaveLength(0)
    expect(extra.queued_failures).toBe(0)
  })

  it("a >100 spike of genuinely-new expected-reason failures pages Sentry with the counts", async () => {
    const N = 101
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: Array.from({ length: N }, (_, i) =>
          eventBlock({
            height: 1100 + (i % 150),
            txId: "2".repeat(62) + String(i % 100).padStart(2, "0"),
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: String(2000 + i),
              lrid: String(20000 + i),
              price: "1.00000000",
            }),
          }),
        ),
      }),
    )
    const failureRow = (i: number) => ({
      listing_resource_id: String(20000 + i),
      flow_id: String(2000 + i),
      failure_reason: "edition_key_unmapped",
    })
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // Every nft derives an edition_key…
      pinnacle_nft_map: {
        data: Array.from({ length: N }, (_, i) => ({ nft_id: String(2000 + i), edition_key: `ek-${i}` })),
        error: null,
      },
      // …but none is known anywhere: 101 edition_key_unmapped failures.
      editions: { data: [], error: null },
      pinnacle_editions: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
      // Two failure-upsert batches (100 + 1), all genuinely new.
      listing_resolution_failures: [
        { data: Array.from({ length: 100 }, (_, i) => failureRow(i)), error: null },
        { data: [failureRow(100)], error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    // edition_key already derived -> the Cadence loop never fires.
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(0)
    expect(v2Upserts(spy)).toHaveLength(N)
    expect(state.breadcrumbs).toHaveLength(N)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.msg).toBe("listing_resolution_failures_inserted")
    expect(state.messages[0]?.ctx).toMatchObject({
      level: "warning",
      tags: { collection: "disney_pinnacle", indexer: "pinnacle-listings-indexer" },
      extra: {
        queued_failures: N,
        failure_reason_counts: { edition_key_unmapped: N },
        unexpected_reason: false,
      },
    })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: N, p_rows_written: N })
    expect((log?.p_extra as Record<string, unknown>).queued_failures).toBe(N)
  })

  it("a never-before-seen failure reason pages regardless of volume — the gate reads the actually-inserted rows", async () => {
    const tx1 = "3".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({ nftId: "740", lrid: "9601", price: "2.00000000" }),
          }),
        ],
        scripts: [scriptResult(null)],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      pinnacle_nft_map: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      cached_listings_v2: { data: [], error: null },
      // The DB echoes back a reason OUTSIDE the expected set (schema/code drift
      // scenario) — reason counting keys off what was really inserted, and an
      // unexpected reason pages at any volume.
      listing_resolution_failures: {
        data: [{ listing_resource_id: "9601", flow_id: "740", failure_reason: "brand_new_regression" }],
        error: null,
      },
    })

    await POST(req())
    await runDeferred()

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.ctx).toMatchObject({
      extra: {
        queued_failures: 1,
        failure_reason_counts: { brand_new_regression: 1 },
        unexpected_reason: true,
      },
    })
  })
})

describe("pinnacle-listings-indexer — completion marking", () => {
  it("purchased/cancelled completions update source-scoped with matched/unmatched accounting", async () => {
    const tx1 = "4".repeat(64)
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
        ],
      }),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // First completion matches an open row; second finds nothing (listed
      // before this indexer existed).
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
      listings_completed_count: 2,
      completed_matched: 1,
      completed_unmatched: 1,
    })
  })

  it("non-Pinnacle nftTypes are filtered before any write (pre/post filter accounting)", async () => {
    const tx1 = "5".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs({
        avail: [
          eventBlock({
            height: 1100,
            txId: tx1,
            eventType: V2_AVAIL,
            payload: availPayload({
              nftId: "999",
              lrid: "9700",
              price: "5.00000000",
              typeID: "A.0b2a3299cc857e29.TopShot.NFT",
            }),
          }),
        ],
        compl: [
          eventBlock({
            height: 1101,
            txId: tx1,
            eventType: V2_COMPL,
            payload: complPayload({ lrid: "9701", purchased: true, typeID: "A.e4cf4bdc1751c65d.AllDay.NFT" }),
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
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.events_pre_filter).toBe(2)
    expect(extra.events_post_filter).toBe(0)
    expect(log?.p_cursor_after).toBe("1250")
  })
})

describe("pinnacle-listings-indexer — cursor + control flow", () => {
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

  it("an HTTP 500 on the event fetch HOLDS the cursor and says so, instead of advancing over the range", async () => {
    // ⚠ This route was held back from the 2026-08-21 sweep that fixed ten
    // sibling indexers, because the one-line throw would have changed nothing
    // here: it had NO hold at all. The chunk catch neither broke nor recorded,
    // and the cursor was written from `targetHeight` unconditionally after the
    // loop, so an upstream 500 advanced the cursor 1000 → 1250 over blocks
    // nothing had read. Nothing revisits a block below the cursor.
    fetchMock = installFetchMock(flowRestStubs({ eventsHttp: { status: 500, text: "upstream boom" } }))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(spy.rpcCalls)
    // The cursor is written, but to where it already was — the chunk that
    // failed starts at 1001, so the cap lands on 1000.
    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1000 })
    expect(log?.p_cursor_after).toBe("1000")

    // ⚠ The flag matters as much as the hold: a held cursor with no flag is
    // indistinguishable from an idle chain in pipeline_runs, so the outage is
    // unfalsifiable — the sub-class this repo rates worst.
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.partial_scan).toBe(true)
    expect(extra.first_failed_chunk).toBe(1001)
    expect(extra.cursor_held_from).toBe(1250)
    // And blocks_scanned reports what was READ, not the range intended.
    expect(extra.blocks_scanned).toBe(0)
  })

  it("401s without the token and defers nothing", async () => {
    install({})
    const res = await POST(
      new NextRequest("https://t/api/pinnacle-listings-indexer", { method: "POST" }),
    )
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
