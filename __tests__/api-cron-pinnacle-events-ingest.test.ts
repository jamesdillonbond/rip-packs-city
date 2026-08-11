import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"
import { cdc, cdcEvent } from "./helpers/flow-cdc-fixture"

// Route integration test for POST /api/cron/pinnacle-events-ingest (+ GET alias).
// Two-stage fail-closed guard (read at REQUEST time): 500 if INGEST_SECRET_TOKEN
// is unset, else 401 on a missing/wrong Bearer or ?token= before any event
// ingest. Beyond the guard the chain scan + upsert run inside after(); we CAPTURE
// the deferred callback and drive it against instrumented Supabase fixtures + a
// stubbed Flow REST / worker fetch so the real ingest body is exercised: first-run
// cursor anchor, already-up-to-date short-circuit, the decode/filter/upsert/
// cursor-advance happy path, and every proxy / sealed-height failure branch.

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
  supabase: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

import { POST, GET } from "@/app/api/cron/pinnacle-events-ingest/route"

const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable"
const PINNACLE_NFT_TYPE_ID = "A.edf9df96c92f4595.Pinnacle.NFT"
const url = "https://t/api/cron/pinnacle-events-ingest"

// Guard-only helper (matches the pre-existing tests' request shape).
const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(url),
  }) as any

// ── after()-body harness ─────────────────────────────────────────────────────
type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}
async function runDeferred() {
  for (const cb of state.afterCbs.splice(0)) await cb()
}
function terminalLog(spy: { rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> }) {
  return spy.rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

// Flow REST sealed-tip stub.
function blocksStub(height: number, opts: { status?: number } = {}): FetchStub {
  return {
    match: (u) => u.includes("/v1/blocks"),
    respond: () => ({ status: opts.status, json: [{ header: { height: String(height) } }] }),
  }
}
// pinnacle-events-proxy /events stub.
function proxyStub(
  body: unknown,
  opts: { status?: number; text?: string; headers?: Record<string, string> } = {},
): FetchStub {
  return {
    match: (u) => u.includes("/events"),
    respond: () => ({ status: opts.status, text: opts.text, headers: opts.headers, json: body }),
  }
}

// One proxy event: base64 JSON-CDC of the ListingAvailable payload, exactly as
// the worker serves it. `badPayload` yields undecodeable bytes.
function proxyEvt(opts: {
  height: number
  txId: string
  fields?: Record<string, unknown>
  badPayload?: boolean
}) {
  return {
    block_height: opts.height,
    block_timestamp: "2026-07-02T00:00:00Z",
    transaction_id: opts.txId,
    event_index: 0,
    type: EVENT_TYPE,
    payload: opts.badPayload
      ? "!!!not-valid-json!!!"
      : Buffer.from(JSON.stringify(cdcEvent(EVENT_TYPE, opts.fields ?? {}))).toString("base64"),
  }
}

// Field builders for the four event shapes the filter/decode path branches on.
const ducPinnacle = (nftId: string, seller = "0xseller1") => ({
  nftType: cdc.nftType(PINNACLE_NFT_TYPE_ID),
  storefrontAddress: cdc.string(seller),
  listingResourceID: cdc.uint64(7000 + Number(nftId)),
  nftID: cdc.uint64(nftId),
  salePrice: cdc.ufix64("40.00000000"),
  salePaymentVaultType: cdc.nftType("A.ead892083b3e2c6c.DapperUtilityCoin.Vault"),
})
const flowPinnacle = (nftId: string) => ({
  nftType: cdc.nftType(PINNACLE_NFT_TYPE_ID),
  storefrontAddress: cdc.string("0xseller2"),
  listingResourceID: cdc.uint64(7000 + Number(nftId)),
  nftID: cdc.uint64(nftId),
  salePrice: cdc.ufix64("5.00000000"),
  salePaymentVaultType: cdc.nftType("A.1654653399040a61.FlowToken.Vault"),
})
const pinnacleNoSeller = (nftId: string) => ({
  nftType: cdc.nftType(PINNACLE_NFT_TYPE_ID),
  // no storefrontAddress -> sellerAddress null -> continue
  listingResourceID: cdc.uint64(7000 + Number(nftId)),
  nftID: cdc.uint64(nftId),
  salePrice: cdc.ufix64("1.00000000"),
  salePaymentVaultType: cdc.nftType("A.ead892083b3e2c6c.DapperUtilityCoin.Vault"),
})
const nonPinnacle = (nftId: string) => ({
  nftType: cdc.nftType("A.0b2a3299cc857e29.TopShot.NFT"),
  storefrontAddress: cdc.string("0xseller3"),
  listingResourceID: cdc.uint64(7000 + Number(nftId)),
  nftID: cdc.uint64(nftId),
  salePrice: cdc.ufix64("2.00000000"),
  salePaymentVaultType: cdc.nftType("A.ead892083b3e2c6c.DapperUtilityCoin.Vault"),
})

let fetchMock: ReturnType<typeof installFetchMock> | null = null

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  state.afterCbs.length = 0
  state.sb = null
})
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})

describe("POST /api/cron/pinnacle-events-ingest", () => {
  it("500s when INGEST_SECRET_TOKEN is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req("Bearer whatever"))).status).toBe(500)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })

  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })
})

describe("POST /api/cron/pinnacle-events-ingest — success path (ingest queued, scan deferred)", () => {
  it("200s and reports 'ingest queued' with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("ingest queued")
    expect(typeof body.started_at).toBe("string")
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await POST(makeReq({ url, token: "test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("ingest queued")
  })
})

describe("POST /api/cron/pinnacle-events-ingest — deferred ingest body", () => {
  it("first run anchors the cursor at the sealed tip with no backscan", async () => {
    fetchMock = installFetchMock([blocksStub(200)])
    const spy = install({ pinnacle_event_cursors: { data: null, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    // No worker /events call on first run.
    expect(fetchMock.calls.some((c) => c.url.includes("/events"))).toBe(false)
    // Cursor was anchored to the sealed tip.
    const cursorWrites = spy.writes.pinnacle_event_cursors ?? []
    expect(cursorWrites.at(-1)?.rows[0]?.last_processed_height).toBe(200)

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_pipeline: "pinnacle-events-ingest",
      p_rows_found: 0,
      p_rows_written: 0,
      p_ok: true,
      p_error: null,
      p_cursor_before: "0",
      p_cursor_after: "200",
    })
    expect(log?.p_extra).toMatchObject({ message: "first run, cursor anchored to sealed tip", sealed_tip: 200 })
  })

  it("short-circuits when the cursor is already at the sealed tip", async () => {
    fetchMock = installFetchMock([blocksStub(200)])
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 200 }, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    expect(fetchMock.calls.some((c) => c.url.includes("/events"))).toBe(false)
    const log = terminalLog(spy)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_cursor_before: "200", p_cursor_after: "200" })
    expect(log?.p_extra).toMatchObject({ message: "already up to date", sealed_tip: 200 })
  })

  it("decodes + filters worker events, upserts only Pinnacle+seller rows, and advances the cursor", async () => {
    fetchMock = installFetchMock([
      blocksStub(200),
      proxyStub({
        events: [
          proxyEvt({ height: 150, txId: "tx-duc", fields: ducPinnacle("9001") }), // matched + DUC -> priceUsd + written
          proxyEvt({ height: 151, txId: "tx-flow", fields: flowPinnacle("9002") }), // matched + FLOW -> priceUsd null + written
          proxyEvt({ height: 152, txId: "tx-noseller", fields: pinnacleNoSeller("9003") }), // matched but no seller -> skipped
          proxyEvt({ height: 153, txId: "tx-other", fields: nonPinnacle("9004") }), // non-Pinnacle -> skipped pre-match
          proxyEvt({ height: 154, txId: "tx-bad", badPayload: true }), // undecodeable
        ],
        blocks_scanned: 100,
      }),
    ])
    const spy = install({
      pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null },
      pinnacle_listing_events: { data: [], error: null },
    })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    // The two USD/native Pinnacle rows were upserted.
    const upserts = (spy.writes.pinnacle_listing_events ?? []).flatMap((w) => w.rows)
    expect(upserts).toHaveLength(2)
    const duc = upserts.find((r) => r.nft_id === "9001")
    const flow = upserts.find((r) => r.nft_id === "9002")
    expect(duc).toMatchObject({ currency: "DUC", price_usd: 40, seller_address: "0xseller1" })
    expect(flow).toMatchObject({ currency: "FLOW", price_usd: null })

    const log = terminalLog(spy)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 5, // every event counts
      p_rows_written: 2,
      p_rows_skipped: 3,
      p_cursor_before: "100",
      p_cursor_after: "200",
      p_collection_slug: "disney_pinnacle",
    })
    expect(log?.p_extra).toMatchObject({
      pinnacle_matched: 3, // duc + flow + no-seller
      undecodeable: 1,
      cursor_advanced_by_blocks: 100,
      proxy_events_total: 5,
    })
  })

  it("logs (does not throw) when the pinnacle_listing_events upsert errors", async () => {
    fetchMock = installFetchMock([
      blocksStub(200),
      proxyStub({ events: [proxyEvt({ height: 150, txId: "tx-duc", fields: ducPinnacle("9001") })] }),
    ])
    const spy = install({
      pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null },
      pinnacle_listing_events: { data: null, error: { message: "dup violation" } },
    })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = terminalLog(spy)
    // Upsert errored -> nothing counted written, but the tick still succeeds and advances.
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 1, p_rows_written: 0, p_cursor_after: "200" })
    expect(log?.p_extra).toMatchObject({ pinnacle_matched: 1 })
  })

  it("fails ok=false with the 404-HTML worker-unrouted error", async () => {
    fetchMock = installFetchMock([
      blocksStub(200),
      proxyStub(null, { status: 404, text: "<!DOCTYPE html><html>not found</html>", headers: { "content-type": "text/html" } }),
    ])
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("proxy_returned_404_html")
  })

  it("fails ok=false with the generic-HTML worker error (non-404)", async () => {
    fetchMock = installFetchMock([
      blocksStub(200),
      proxyStub(null, { status: 502, text: "<html><body>bad gateway</body></html>", headers: { "content-type": "text/html" } }),
    ])
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("proxy_returned_html")
  })

  it("fails ok=false with a non-HTML proxy HTTP error", async () => {
    fetchMock = installFetchMock([
      blocksStub(200),
      proxyStub(null, { status: 500, text: "internal boom", headers: { "content-type": "application/json" } }),
    ])
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("proxy HTTP 500")
  })

  it("fails ok=false when the sealed-height read errors", async () => {
    fetchMock = installFetchMock([blocksStub(0, { status: 500 })])
    const spy = install({ pinnacle_event_cursors: { data: { last_processed_height: 100 }, error: null } })

    await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    await runDeferred()

    const log = terminalLog(spy)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("blocks sealed HTTP 500")
  })
})
