import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"
import { cdc, cdcEvent } from "./helpers/flow-cdc-fixture"

// Deep-drive of POST /api/cron/pinnacle-events-ingest — the chain-event Pinnacle
// LISTING ingest (Phase 2B). Reads the pinnacle_event_cursors row, asks the
// pinnacle-events-proxy Worker for the next window of ListingAvailable events,
// filters to Pinnacle NFTs, and upserts pinnacle_listing_events. Work runs in
// after(); logs pipeline_runs in a finally. Pinned:
//   - first-run init anchors the cursor at the sealed tip with NO backscan and
//     no proxy call (cursorBefore "0");
//   - already-up-to-date logs the message, no proxy call;
//   - happy ingest: exact listing row (currency from vaultType, price_usd only
//     for USD-equivalent DUC/FUT, else null; a seller-less event is matched but
//     not inserted), cursor advances to endHeight, rows_found/written/skipped;
//   - a proxy 404-HTML response throws the diagnostic proxy_returned_404_html
//     and logs ok=false;
//   - a sealed-height fetch failure logs ok=false; both auth guards fail-closed.

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

process.env.INGEST_SECRET_TOKEN = "events-token"
const { POST, GET } = await import("@/app/api/cron/pinnacle-events-ingest/route")

const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const PINNACLE_NFT = "A.edf9df96c92f4595.Pinnacle.NFT"
const DUC_VAULT = "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"
const FLOW_VAULT = "A.1654653399040a61.FlowToken.Vault"

// A ListingAvailable proxy event: base64(JSON-CDC) as the worker returns it.
function listingEvent(opts: {
  height: number
  txId: string
  nftId: string
  lrid: string
  price: string
  seller?: string | null
  typeID?: string
  vaultTypeID?: string
}) {
  const fields: Record<string, unknown> = {
    listingResourceID: cdc.uint64(opts.lrid),
    nftType: cdc.nftType(opts.typeID ?? PINNACLE_NFT),
    nftID: cdc.uint64(opts.nftId),
    salePrice: cdc.ufix64(opts.price),
    salePaymentVaultType: cdc.nftType(opts.vaultTypeID ?? DUC_VAULT),
  }
  if (opts.seller !== null) {
    fields.storefrontAddress = { type: "Address", value: opts.seller ?? "0xabcabcabcabcabca" }
  }
  return {
    block_height: opts.height,
    block_timestamp: "2026-07-17T12:00:00Z",
    transaction_id: opts.txId,
    event_index: 0,
    type: EVENT_TYPE,
    payload: Buffer.from(JSON.stringify(cdcEvent(EVENT_TYPE, fields))).toString("base64"),
  }
}

function stubs(opts: {
  sealedHeight?: number
  sealedStatus?: number
  proxyBody?: unknown
  proxyStatus?: number
  proxyText?: string
}): FetchStub[] {
  return [
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () =>
        opts.sealedStatus
          ? { status: opts.sealedStatus, ok: false, text: "sealed boom" }
          : { json: [{ header: { height: String(opts.sealedHeight ?? 2000) } }] },
    },
    {
      match: (url) => url.includes("pinnacle-events-proxy"),
      respond: () =>
        opts.proxyStatus
          ? { status: opts.proxyStatus, ok: false, text: opts.proxyText ?? "err" }
          : { json: opts.proxyBody ?? { events: [] } },
    },
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/cron/pinnacle-events-ingest", {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer events-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function logRun(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "events-token"
  state.afterCbs.length = 0
})

describe("pinnacle-events-ingest — auth", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    install({})
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("401s with a wrong bearer token, defers nothing", async () => {
    install({})
    const res = await POST(req({ authorization: "Bearer wrong" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})

describe("pinnacle-events-ingest — control paths", () => {
  it("first-run init anchors the cursor at the sealed tip with no backscan / no proxy call", async () => {
    fetchMock = installFetchMock(stubs({ sealedHeight: 5000 }))
    const spy = install({ pinnacle_event_cursors: { data: null, error: null } })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    const cursorUpsert = (spy.writes.pinnacle_event_cursors ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ event_type: EVENT_TYPE, last_processed_height: 5000 })
    // No proxy /events fetch on first run.
    expect(fetchMock.calls.some((c) => c.url.includes("pinnacle-events-proxy"))).toBe(false)

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_cursor_before: "0", p_cursor_after: "5000", p_collection_slug: "disney_pinnacle" })
    expect((log?.p_extra as Record<string, unknown>).message).toBe("first run, cursor anchored to sealed tip")
  })

  it("already-up-to-date logs the message and skips the proxy", async () => {
    fetchMock = installFetchMock(stubs({ sealedHeight: 2000 }))
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 2000 }, error: null } })

    await POST(req())
    await runDeferred()

    expect(fetchMock.calls.some((c) => c.url.includes("pinnacle-events-proxy"))).toBe(false)
    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_cursor_before: "2000", p_cursor_after: "2000" })
    expect((log?.p_extra as Record<string, unknown>).message).toBe("already up to date")
  })
})

describe("pinnacle-events-ingest — scan + write", () => {
  it("ingests Pinnacle listings (currency + usd derivation, seller-less filtered), advances the cursor", async () => {
    fetchMock = installFetchMock(
      stubs({
        sealedHeight: 2000,
        proxyBody: {
          events: [
            // DUC -> price_usd = salePrice
            listingEvent({ height: 1100, txId: "tx1", nftId: "111", lrid: "9001", price: "12.50000000", seller: "0x1111111111111111" }),
            // FlowToken -> not USD-equivalent -> price_usd null
            listingEvent({ height: 1101, txId: "tx2", nftId: "222", lrid: "9002", price: "3.00000000", seller: "0x2222222222222222", vaultTypeID: FLOW_VAULT }),
            // non-Pinnacle nftType -> filtered (not matched)
            listingEvent({ height: 1102, txId: "tx3", nftId: "333", lrid: "9003", price: "1.00000000", seller: "0x3333333333333333", typeID: "A.0b2a3299cc857e29.TopShot.NFT" }),
            // Pinnacle but seller-less -> matched, but skipped (no insert)
            listingEvent({ height: 1103, txId: "tx4", nftId: "444", lrid: "9004", price: "2.00000000", seller: null }),
          ],
          blocks_scanned: 1000,
        },
      }),
    )
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 1000 }, error: null } })

    await POST(req())
    await runDeferred()

    const rows = (spy.writes.pinnacle_listing_events ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.nft_id === "111")).toMatchObject({
      event_type: EVENT_TYPE,
      block_height: 1100,
      transaction_hash: "tx1",
      listing_resource_id: "9001",
      nft_id: "111",
      seller_address: "0x1111111111111111",
      price_native: 12.5,
      currency: "DUC",
      price_usd: 12.5,
      listed_at: "2026-07-17T12:00:00Z",
    })
    expect(rows.find((r) => r.nft_id === "222")).toMatchObject({ currency: "FLOW", price_usd: null })

    // Cursor advanced to endHeight = min(1000+10000, 2000) = 2000.
    const cursorUpsert = (spy.writes.pinnacle_event_cursors ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ last_processed_height: 2000 })

    const log = logRun(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 4, // all proxy events counted
      p_rows_written: 2, // two inserted
      p_rows_skipped: 2,
      p_cursor_before: "1000",
      p_cursor_after: "2000",
    })
    const extra = log?.p_extra as Record<string, unknown>
    expect(extra.pinnacle_matched).toBe(3) // 111, 222, 444 (444 seller-less, still matched)
    expect(extra.blocks_scanned).toBe(1000)
  })

  it("a proxy 404-HTML response throws the diagnostic and logs ok=false", async () => {
    fetchMock = installFetchMock(
      stubs({ sealedHeight: 2000, proxyStatus: 404, proxyText: "<!DOCTYPE html><html>not found</html>" }),
    )
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 1000 }, error: null } })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("proxy_returned_404_html")
    // Cursor NOT advanced on the fatal path.
    expect(spy.writes.pinnacle_event_cursors ?? []).toHaveLength(0)
  })

  it("a sealed-height fetch failure logs ok=false", async () => {
    fetchMock = installFetchMock(stubs({ sealedStatus: 503 }))
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 1000 }, error: null } })

    await POST(req())
    await runDeferred()

    const log = logRun(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("blocks sealed HTTP 503")
  })

  it("GET alias reaches the same queued accept", async () => {
    fetchMock = installFetchMock(stubs({ sealedHeight: 2000 }))
    install({ pinnacle_event_cursors: { data: { last_processed_height: 2000 }, error: null } })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("ingest queued")
    await runDeferred()
  })
})
