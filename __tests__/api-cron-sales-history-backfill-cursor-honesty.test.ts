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
  V2_FLOWTY_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A FAILED READ MUST NOT RESET A BACKWARD WALK.
//
// The five `*-sales-history-backfill` routes walk BACKWARD from a ceiling toward
// the spork floor, and `event_cursor.last_processed_block` holds the LOWEST block
// already scanned. Every one of them opened with
//
//     const { data: cursorRow } = await supabaseAdmin.from("event_cursor")…
//     if (cursorRow && Number(cursorRow.last_processed_block) > 0) ceiling = …
//
// with `error` discarded. supabase-js RETURNS its errors rather than throwing, so
// a failed read left `ceiling` at CEILING_INIT — the TOP of the walk — and the
// tick then scanned near the top and UPSERTED THAT HIGH BLOCK BACK OVER THE REAL
// CURSOR. One transient database blip therefore discarded every block of backward
// progress, silently, and reported `ok: true`. Nothing re-walks a range above the
// cursor, so the history skipped in between is not recovered by a later tick.
//
// A second, adjacent defect: the cursor upsert also discarded its result while
// `cursorWritten` was assigned unconditionally, so a FAILED advance was logged as
// a cursor MOVEMENT. `p_cursor_after` is the one instrument an operator would use
// to notice any of this, and it was reporting an unmeasured number.
//
// Every assertion below is an ABSENCE — no cursor write, no sales write, no
// claimed movement — because the presence of an error message was never the
// problem. AllDay is driven here as the family's largest copy; the ratchet test
// `consequential-read-binds-its-error-ratchet` pins all five structurally.
// ─────────────────────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async () => ({
    buyer: null,
    seller: null,
    priceDuc: null,
    priceCertain: false,
    priceReason: "no_duc_transfer",
    sampleAmounts: [],
  }),
}))

process.env.INGEST_SECRET_TOKEN = "history-token"
const { POST } = await import("@/app/api/cron/allday-sales-history-backfill/route")

const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
// Deliberately far BELOW the route's CEILING_INIT. That gap is the whole point:
// if a failed read falls through to CEILING_INIT, the cursor written back is
// enormously higher than this, which is the progress loss being pinned.
const REAL_CURSOR = 137_400_000

function sale(nftId: string, price: string) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9001),
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

function flowStubs(): FetchStub[] {
  return [
    { match: (u) => u.includes("/v1/scripts"), respond: () => ({ json: scriptResult(null) }) },
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", [
      eventBlock({
        height: REAL_CURSOR - 100,
        txId: "a".repeat(64),
        eventType: V2_FLOWTY_LISTING_COMPLETED,
        payload: sale("555", "5.00000000"),
      }),
    ]),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted", []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const req = () =>
  new NextRequest("https://t/api/cron/allday-sales-history-backfill?range=250", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer history-token" }),
  })

const terminalLog = (rpcCalls: RecordedRpcCall[]) =>
  rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined

const resolvable: Fixtures = {
  wallet_moments_cache: {
    data: [{ moment_id: "555", edition_key: "AD-EDITION-1", serial_number: 12 }],
    error: null,
  },
  editions: { data: [{ id: "uuid-ad-1", external_id: "AD-EDITION-1" }], error: null },
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
})

describe("allday-sales-history-backfill — a failed cursor READ cannot rewind the walk", () => {
  it("500s, writes NO cursor, and scans nothing when the cursor read errors", async () => {
    fetchMock = installFetchMock(flowStubs())
    const spy = install({
      ...resolvable,
      event_cursor: { data: null, error: { message: "cursor read boom" } },
    })

    const res = await POST(req())
    expect(res.status).toBe(500)

    // ⛔ THE LOAD-BEARING ABSENCE. Before the fix this run upserted
    // last_processed_block back near CEILING_INIT, discarding the walk.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    // And it must not have written sales off a range it decided to scan blind.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("cursor read failed")
    // It never scanned, so it must not claim a before/after position either.
    expect(log.p_cursor_before).toBeNull()
    expect(log.p_cursor_after).toBeNull()
  })

  it("uses the stored cursor as the ceiling on the happy path (positive control)", async () => {
    // Without this the test above passes for a route that simply never runs.
    fetchMock = installFetchMock(flowStubs())
    const spy = install({
      ...resolvable,
      event_cursor: { data: { last_processed_block: REAL_CURSOR }, error: null },
    })

    expect((await POST(req())).status).toBe(200)
    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(true)
    expect(log.p_cursor_before).toBe(String(REAL_CURSOR))
    // The walk went DOWN from the stored cursor, never up.
    expect(Number(log.p_cursor_after)).toBeLessThan(REAL_CURSOR)
    const written = (spy.writes.event_cursor ?? []).filter((w) => w.method === "upsert")
    expect(written).toHaveLength(1)
    expect(Number(written[0].rows[0].last_processed_block)).toBeLessThan(REAL_CURSOR)
  })
})

describe("allday-sales-history-backfill — a failed cursor WRITE is not a movement", () => {
  it("reports cursor_after === cursor_before and ok:false when the upsert errors", async () => {
    fetchMock = installFetchMock(flowStubs())
    // Call 1 is the read; call 2 is the upsert.
    const spy = install({
      ...resolvable,
      event_cursor: [
        { data: { last_processed_block: REAL_CURSOR }, error: null },
        { data: null, error: { message: "cursor write boom" } },
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(500)

    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("cursor upsert failed")
    // ⛔ The absence that matters: no claimed progress. Before the fix this read
    // back the new low block while the stored cursor had not moved at all.
    expect(log.p_cursor_after).toBe(log.p_cursor_before)
    expect(log.p_cursor_after).toBe(String(REAL_CURSOR))
  })
})

describe("allday-sales-history-backfill — a failed id lookup is not 'unmapped'", () => {
  it("does not advance the cursor when the wallet_moments_cache lookup errors", async () => {
    fetchMock = installFetchMock(flowStubs())
    const spy = install({
      event_cursor: { data: { last_processed_block: REAL_CURSOR }, error: null },
      wallet_moments_cache: { data: null, error: { message: "wmc down" } },
      editions: { data: [], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(500)

    // ⛔ The cursor must stay put so the SAME range is re-scanned next tick.
    // Before the fix the read looked like "nothing is mapped", the sale was
    // written as unmapped, and the walk moved on past it for good.
    expect((spy.writes.event_cursor ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

    const log = terminalLog(spy.rpcCalls)!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toContain("wallet_moments_cache lookup failed")
    expect(log.p_cursor_after).toBe(log.p_cursor_before)
  })
})
