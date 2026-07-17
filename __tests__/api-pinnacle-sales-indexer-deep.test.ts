import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { cdc, cdcEvent, eventBlock, V2_DAPPER_LISTING_COMPLETED } from "./helpers/flow-cdc-fixture"

// Deep-drive of GET/POST /api/pinnacle-sales-indexer — the on-chain Disney
// Pinnacle sales walker (single V2 Dapper source). Unlike the sibling backfill,
// this route runs the scan INLINE (no after()) and logs NOTHING to pipeline_runs
// — it returns its accounting in the JSON body. Pinned contracts:
//   - writes PINNACLE_SALES (render-keyed), id=`${tx}_${nft}` PK, source='on-chain',
//     buyer=commissionReceiver, seller null, serial null; NO unmapped_sales lane —
//     an unresolved nft is STILL written with edition_id null (salesUnresolved++);
//   - nftID -> edition_key ladder is pinnacle_nft_map first, wmc second;
//   - a TopShot nftType and an unpurchased listing are filtered before accounting;
//   - the cursor advances per-chunk (event_cursor.update) even on a no-events tick;
//   - upsert(ignoreDuplicates) counts the batch as written; 23505 -> duped; a
//     non-23505 batch error falls back to per-row upserts;
//   - resolve-buyers is chained on EVERY non-fatal exit (incl. up-to-date + empty);
//   - a cursor-read error 500s "Failed to read cursor"; a fatal (sealed down) 500s
//     with no chain.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))

process.env.INGEST_SECRET_TOKEN = "pinnacle-indexer-token"
const { GET, POST } = await import("@/app/api/pinnacle-sales-indexer/route")

const PINNACLE_NFT = "A.edf9df96c92f4595.Pinnacle.NFT"
const SEALED = 1300
const CURSOR_START = 1000
const TARGET = 1250 // CURSOR_START + range(250)

function pinnacleSale(
  nftId: string,
  price: string,
  txId: string,
  height: number,
  opts: { commission?: string; typeID?: string; purchased?: boolean } = {},
) {
  return eventBlock({
    height,
    txId,
    eventType: V2_DAPPER_LISTING_COMPLETED,
    payload: cdcEvent(V2_DAPPER_LISTING_COMPLETED, {
      listingResourceID: cdc.uint64(9400 + (Number(nftId) % 1000)),
      storefrontResourceID: cdc.uint64(1),
      purchased: cdc.bool(opts.purchased ?? true),
      nftType: cdc.nftType(opts.typeID ?? PINNACLE_NFT),
      nftID: cdc.uint64(nftId),
      salePrice: cdc.ufix64(price),
      commissionReceiver: opts.commission
        ? { type: "Optional", value: { type: "Address", value: opts.commission } }
        : cdc.optionalNull(),
    }),
  })
}

function flowStubs(opts: { events?: unknown[]; sealedStatus?: number; sealedHeight?: number }): FetchStub[] {
  return [
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () =>
        opts.sealedStatus
          ? { status: opts.sealedStatus, ok: false, text: "boom" }
          : { json: [{ header: { height: String(opts.sealedHeight ?? SEALED) } }] },
    },
    jsonRoute("/v1/events", opts.events ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/pinnacle-sales-indexer${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer pinnacle-indexer-token" }),
  })
}

const cursorFixture = { data: { last_processed_block: CURSOR_START }, error: null }

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "pinnacle-indexer-token"
  state.chained.length = 0
})

describe("pinnacle-sales-indexer — auth + control paths", () => {
  it("401s without a token and does no DB work", async () => {
    const spy = install({})
    const res = await POST(new NextRequest("https://t/api/pinnacle-sales-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(state.chained).toHaveLength(0)
  })

  it("500s 'Failed to read cursor' on a cursor-read error, no chain", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: { data: null, error: { message: "denied" } } })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Failed to read cursor")
    expect(state.chained).toHaveLength(0)
    expect(Object.keys(spy.writes)).toHaveLength(0)
  })

  it("'already up to date' chains resolve-buyers (drains residue) and writes nothing", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedHeight: SEALED }))
    const spy = install({ event_cursor: { data: { last_processed_block: SEALED }, error: null } })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, message: "already up to date", cursor: SEALED })
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
    expect(spy.writes.pinnacle_sales ?? []).toHaveLength(0)
  })

  it("a fatal (sealed-height fetch down) 500s and does NOT chain", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedStatus: 500 }))
    install({ event_cursor: cursorFixture })
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("Internal server error")
    expect(String(body.details)).toContain("blocks sealed HTTP 500")
    expect(state.chained).toHaveLength(0)
  })
})

describe("pinnacle-sales-indexer — scan + write", () => {
  it("ingests Pinnacle sales (map+wmc ladder, unresolved kept null), advances the cursor, chains resolve-buyers", async () => {
    const txA = "1".repeat(64)
    const txB = "2".repeat(64)
    const txC = "3".repeat(64)
    fetchMock = installFetchMock(
      flowStubs({
        events: [
          pinnacleSale("111", "4.00000000", txA, CURSOR_START + 20, { commission: "0xaaaaaaaaaaaaaaaa" }),
          pinnacleSale("222", "6.50000000", txB, CURSOR_START + 30),
          pinnacleSale("333", "2.00000000", txC, CURSOR_START + 40, { commission: "0xbbbbbbbbbbbbbbbb" }),
          // filtered before accounting:
          pinnacleSale("998", "1.00000000", "8".repeat(64), CURSOR_START + 50, { typeID: "A.0b2a3299cc857e29.TopShot.NFT" }),
          pinnacleSale("997", "1.00000000", "9".repeat(64), CURSOR_START + 60, { purchased: false }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "111", edition_key: "RC1:Standard:1" }], error: null },
      wallet_moments_cache: { data: [{ moment_id: "222", edition_key: "RC2:Chaser:2" }], error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const rows = (spy.writes.pinnacle_sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.nft_id === "111")).toEqual({
      id: `${txA}_111`,
      edition_id: "RC1:Standard:1", // rung 1: pinnacle_nft_map
      nft_id: "111",
      sale_price_usd: 4,
      serial_number: null,
      sold_at: "2026-07-17T12:00:00Z",
      source: "on-chain",
      buyer_address: "0xaaaaaaaaaaaaaaaa",
      seller_address: null,
    })
    expect(rows.find((r) => r.nft_id === "222")).toMatchObject({
      edition_id: "RC2:Chaser:2", // rung 2: wmc fallback
      buyer_address: null,
    })
    // Unresolved sale is STILL written with a null edition (no unmapped lane).
    expect(rows.find((r) => r.nft_id === "333")).toMatchObject({
      id: `${txC}_333`,
      edition_id: null,
      sale_price_usd: 2,
      buyer_address: "0xbbbbbbbbbbbbbbbb",
    })
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(spy.writes.sales ?? []).toHaveLength(0)

    // Per-chunk cursor update advanced to the target height.
    const cursorUpdate = (spy.writes.event_cursor ?? []).find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: TARGET })

    expect(await res.json()).toMatchObject({
      ok: true,
      eventsFound: 3,
      salesInserted: 3,
      salesDuped: 0,
      salesUnresolved: 1,
      cursor: TARGET,
    })
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
  })

  it("a no-events tick still advances the cursor per-chunk and chains resolve-buyers", async () => {
    fetchMock = installFetchMock(flowStubs({ events: [] }))
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, eventsFound: 0, salesInserted: 0, cursor: TARGET })
    const cursorUpdate = (spy.writes.event_cursor ?? []).find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: TARGET })
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
  })

  it("a whole-batch 23505 counts the batch as duped, never inserted", async () => {
    fetchMock = installFetchMock(
      flowStubs({ events: [pinnacleSale("444", "3.00000000", "4".repeat(64), CURSOR_START + 20)] }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "444", edition_key: "RC3:Standard:1" }], error: null },
      pinnacle_sales: { error: { code: "23505", message: "duplicate key value" } },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, eventsFound: 1, salesInserted: 0, salesDuped: 1 })
    expect(state.chained).toEqual([{ path: "/api/pinnacle/resolve-buyers", chain: true }])
  })

  it("a non-23505 batch error falls back to per-row upserts (each dupe accounted)", async () => {
    fetchMock = installFetchMock(
      flowStubs({ events: [pinnacleSale("555", "5.00000000", "5".repeat(64), CURSOR_START + 20)] }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      pinnacle_nft_map: { data: [{ nft_id: "555", edition_key: "RC4:Standard:1" }], error: null },
      pinnacle_sales: { error: { code: "40001", message: "serialization failure" } },
    })
    const res = await POST(req())
    // batch upsert (1) + per-row retry (1) both recorded as writes.
    expect((spy.writes.pinnacle_sales ?? []).length).toBe(2)
    expect(await res.json()).toMatchObject({ ok: true, salesInserted: 0, salesDuped: 1 })
  })

  it("GET delegates to the same handler (401 without auth)", async () => {
    install({})
    const res = await GET(new NextRequest("https://t/api/pinnacle-sales-indexer", { method: "GET" }))
    expect(res.status).toBe(401)
  })
})
