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
  v1SalePayload,
  v2DapperSalePayload,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
  V2_FLOWTY_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/cron/golazos-sales-history-backfill — the THREE-SOURCE
// backward walker (V1 Dapper + V2 Dapper + V2 Flowty), the Golazos sibling of
// allday-sales-history-backfill. Route is SYNCHRONOUS; fixtures feed the real
// scan body Flow-REST JSON-CDC bytes. Pinned contracts (incl. sibling drift):
//   - venue triple: v1_dapper -> marketplace 'laligagolazos' + source
//     'onchain_dapper_v1' (price from decodeV1SaleTx only); v2_dapper ->
//     'laligagolazos' + 'onchain_dapper_v2' (price INLINE, decode used only for
//     buyer/seller); v2_flowty -> 'flowty' + 'onchain' with buyer taken from
//     the event's commissionReceiver (DRIFT vs allday, which reads `buyer`);
//   - non-Golazos nftTypes and purchased=false are filtered before accounting;
//   - the Cadence borrow fallback returns [editionID, serialNumber] UInt64s
//     (Golazos shape), persists nft_edition_map, and the sale lands keyed to
//     the resolved edition — but there is NO on-chain edition-hydration path
//     (DRIFT vs allday: an unknown edition stays unmapped);
//   - price-uncertain / unresolvable sales go to unmapped_sales with
//     resolution_hint.backfill='golazos_v1_history', counted as skipped;
//   - backward cursor `golazos_sales_v1_backfill` advances to ceiling-window;
//     a cursor at the spork floor short-circuits BEFORE the promote/finally;
//   - fatal errors still run the finally-promote, log ok=false, and 500;
//   - dryRun decodes a sample but writes/logs nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<
    string,
    {
      buyer?: string | null
      seller?: string | null
      priceDuc?: number | null
      priceCertain?: boolean
      priceReason?: string
      sampleAmounts?: number[]
    }
  >,
  decodeCalls: [] as Array<{ tx: string; nftId: string; deposit: string; withdraw: string }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (
    tx: string,
    opts: { nftId: string; depositEventType: string; withdrawEventType: string },
  ) => {
    state.decodeCalls.push({ tx, nftId: opts.nftId, deposit: opts.depositEventType, withdraw: opts.withdrawEventType })
    const d = state.decodeByTx[tx] ?? {}
    return {
      buyer: d.buyer ?? null,
      seller: d.seller ?? null,
      priceDuc: d.priceDuc ?? null,
      priceCertain: d.priceCertain ?? false,
      priceReason: d.priceReason ?? "no_duc_transfer",
      sampleAmounts: d.sampleAmounts ?? [],
    }
  },
}))

// TOKEN is captured into a module const at import time — set env FIRST.
process.env.INGEST_SECRET_TOKEN = "golazos-history-token"
const { POST } = await import("@/app/api/cron/golazos-sales-history-backfill/route")

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const GOLAZOS_NFT = "A.87ca73a41bb50ad5.Golazos.NFT"
const CURSOR_ID = "golazos_sales_v1_backfill"
const SPORK_FLOOR = 137_390_146
// Default test window: ceiling 148,000,000 with ?range=250 -> ONE 250-block chunk.
const CEILING = 148_000_000
const START = CEILING - 250

/** V2 Flowty ListingCompleted purchase payload — Golazos reads the buyer from
 *  commissionReceiver (NOT a `buyer` field; that's the allday drift). */
function flowtyPayload(
  nftId: string,
  price: string,
  opts: { commission?: string; typeID?: string; purchased?: boolean } = {},
) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9100 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    purchased: cdc.bool(opts.purchased ?? true),
    nftType: cdc.nftType(opts.typeID ?? GOLAZOS_NFT),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    commissionReceiver: opts.commission
      ? { type: "Optional", value: { type: "Address", value: opts.commission } }
      : cdc.optionalNull(),
  })
}

/** Encode a Cadence [UInt64] script result the way Flow REST returns it. */
function cdcUInt64Array(values: Array<string | number>) {
  const node = { type: "Array", value: values.map((v) => ({ type: "UInt64", value: String(v) })) }
  return { value: Buffer.from(JSON.stringify(node)).toString("base64") }
}

function flowStubs(events: {
  v1?: unknown[]
  v2d?: unknown[]
  v2f?: unknown[]
  scripts?: Array<{ value: string }>
  txJson?: unknown
}): FetchStub[] {
  let scriptCall = 0
  return [
    {
      match: (url) => url.includes("/v1/scripts"),
      respond: () => {
        const r = events.scripts?.[Math.min(scriptCall, (events.scripts?.length ?? 1) - 1)]
        scriptCall++
        return { json: r ?? { value: "" } }
      },
    },
    jsonRoute("/v1/transactions/", events.txJson ?? { proposal_key: null, authorizers: [], payer: null }),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", events.v2f ?? []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", events.v2d ?? []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted", events.v1 ?? []),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/golazos-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer golazos-history-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

const cursorFixture = { data: { last_processed_block: CEILING }, error: null }

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "golazos-history-token"
  delete process.env.GOLAZOS_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("golazos-sales-history-backfill — control paths", () => {
  it("401s without any token; accepts CRON_SECRET via ?token= and the kill-switch logs an honest ok run", async () => {
    const spy = install({})
    const res = await POST(req("?range=250", {}))
    expect(res.status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.CRON_SECRET = "vercel-cron-secret"
    process.env.GOLAZOS_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res2 = await POST(req("?range=250&token=vercel-cron-secret", {}))
    expect(res2.status).toBe(200)
    expect(await res2.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("self-throttles on platform saturation and logs the skip before any cursor/scan work", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 16 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 16 })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).skipped).toBe("saturation")
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
  })

  it("a cursor at the spork floor short-circuits BEFORE the try/finally: no scan, no promote, no cursor write", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({
      event_cursor: { data: { last_processed_block: SPORK_FLOOR }, error: null },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, note: "reached_spork_floor", floor: SPORK_FLOOR })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_cursor_before: String(SPORK_FLOOR),
      p_cursor_after: String(SPORK_FLOOR), // parked, not advanced
    })
    expect((log?.p_extra as Record<string, unknown>).note).toBe("reached_spork_floor_hint")
    // Floor return happens above the try/finally — promote must NOT fire.
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(false)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
  })
})

describe("golazos-sales-history-backfill — scan + write", () => {
  it("ingests all three venues with correct marketplace/source tags, filters foreign types, advances the cursor, promotes", async () => {
    const txV1 = "1".repeat(64)
    const txV2d = "2".repeat(64)
    const txV2f = "3".repeat(64)
    state.decodeByTx[txV1] = {
      buyer: "0x0101010101010101",
      seller: "0x0202020202020202",
      priceDuc: 42,
      priceCertain: true,
    }
    // V2 Dapper price stays INLINE — decode supplies parties only.
    state.decodeByTx[txV2d] = { buyer: "0x0303030303030303", seller: "0x0404040404040404" }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [
          eventBlock({ height: CEILING - 200, txId: txV1, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "801", true, GOLAZOS_NFT) }),
          // A TopShot NFT on the V1 storefront — filtered before any accounting.
          eventBlock({ height: CEILING - 199, txId: "9".repeat(64), eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("998", "802", true, "A.0b2a3299cc857e29.TopShot.NFT") }),
        ],
        v2d: [
          eventBlock({ height: CEILING - 150, txId: txV2d, eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("666", "12.00000000", GOLAZOS_NFT) }),
        ],
        v2f: [
          eventBlock({ height: CEILING - 100, txId: txV2f, eventType: V2_FLOWTY_LISTING_COMPLETED, payload: flowtyPayload("777", "9.50000000", { commission: "0xcccccccccccccccc" }) }),
          // purchased=false must be filtered.
          eventBlock({ height: CEILING - 99, txId: "8".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: flowtyPayload("888", "1.00000000", { purchased: false }) }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: {
        data: [
          { moment_id: "555", edition_key: "901", serial_number: 12 },
          { moment_id: "666", edition_key: "902", serial_number: 34 },
          { moment_id: "777", edition_key: "903", serial_number: 56 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "uuid-901", external_id: "901" },
          { id: "uuid-902", external_id: "902" },
          { id: "uuid-903", external_id: "903" },
        ],
        error: null,
      },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // Only the v1 + v2_dapper sales hit the decoder; the flowty leg never does.
    expect(state.decodeCalls.map((c) => c.tx)).toEqual([txV1, txV2d])
    expect(state.decodeCalls[0]).toMatchObject({
      deposit: "A.87ca73a41bb50ad5.Golazos.Deposit",
      withdraw: "A.87ca73a41bb50ad5.Golazos.Withdraw",
    })

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(3)
    expect(saleRows.find((r) => r.nft_id === "555")).toMatchObject({
      edition_id: "uuid-901",
      collection_id: GOLAZOS,
      collection: "laliga_golazos",
      price_usd: 42, // decoded, NOT from the (null) V1 event price
      serial_number: 12,
      marketplace: "laligagolazos",
      source: "onchain_dapper_v1",
      block_height: CEILING - 200,
      transaction_hash: txV1,
      buyer_address: "0x0101010101010101",
      seller_address: "0x0202020202020202",
    })
    expect(saleRows.find((r) => r.nft_id === "666")).toMatchObject({
      price_usd: 12, // inline event price survives the decode (parties only)
      serial_number: 34,
      marketplace: "laligagolazos",
      source: "onchain_dapper_v2",
      buyer_address: "0x0303030303030303",
      seller_address: "0x0404040404040404",
    })
    expect(saleRows.find((r) => r.nft_id === "777")).toMatchObject({
      price_usd: 9.5,
      serial_number: 56,
      marketplace: "flowty",
      source: "onchain",
      buyer_address: "0xcccccccccccccccc", // Golazos drift: commissionReceiver IS the buyer field
      seller_address: null,
    })
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

    const cursorUpsert = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ id: CURSOR_ID, last_processed_block: START })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 3, // the 2 filtered events never entered the sale set
      p_rows_written: 3,
      p_rows_skipped: 0,
      p_cursor_before: String(CEILING),
      p_cursor_after: String(START),
      p_collection_slug: "laliga_golazos",
    })
    expect(log?.p_extra).toMatchObject({
      scanned: `${START}-${CEILING - 1}`,
      blocks: 250,
      v1_decoded: 1,
      below_floor: false,
      rawV1: 2,
      v1In: 1,
      rawV2Dapper: 1,
      v2DapperIn: 1,
      rawV2Flowty: 2,
      v2FlowtyIn: 1,
    })
    expect(spy.rpcCalls.find((c) => c.name === "promote_unmapped_sales")?.args).toEqual({ p_collection_id: GOLAZOS })
    expect(await res.json()).toMatchObject({
      ok: true,
      found: 3,
      sales_written: 3,
      unmapped_written: 0,
      next_ceiling: START,
    })
  })

  it("price-uncertain and unresolvable sales land in unmapped_sales with golazos_v1_history hints, counted as skipped", async () => {
    const txUncertain = "4".repeat(64)
    const txUnresolved = "5".repeat(64)
    // 701 resolves an edition but the DUC split is ambiguous -> price 0, never guessed.
    state.decodeByTx[txUncertain] = {
      buyer: "0x0505050505050505",
      priceCertain: false,
      priceReason: "multiple_duc_transfers",
      sampleAmounts: [10, 90],
    }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: CEILING - 180, txId: txUncertain, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("701", "811", true, GOLAZOS_NFT) })],
        // 702: inline-certain price but nothing resolves it (no decode buyer, tx
        // participants empty -> no borrow candidates).
        v2d: [eventBlock({ height: CEILING - 170, txId: txUnresolved, eventType: V2_DAPPER_LISTING_COMPLETED, payload: v2DapperSalePayload("702", "15.00000000", GOLAZOS_NFT) })],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [{ moment_id: "701", edition_key: "901", serial_number: 4 }], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-901", external_id: "901" }], error: null },
    })

    await POST(req())

    // Even the RESOLVED edition never reaches `sales` with an uncertain price.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(2)
    const uncertainRow = unmapped.find((r) => r.nft_id === "701")
    expect(uncertainRow).toMatchObject({
      collection_id: GOLAZOS,
      price_usd: 0,
      marketplace: "laligagolazos",
      source: "onchain_dapper_v1",
      buyer_address: "0x0505050505050505",
    })
    expect(uncertainRow?.resolution_hint).toMatchObject({
      nft_id: "701",
      sale_source: "v1_dapper",
      backfill: "golazos_v1_history",
      edition_id: "901",
      price_extraction: "multiple_duc_transfers",
      sample_duc_amounts: [10, 90],
    })
    const unresolvedRow = unmapped.find((r) => r.nft_id === "702")
    expect(unresolvedRow).toMatchObject({
      price_usd: 15,
      serial_number: 0,
      source: "onchain_dapper_v2",
    })
    expect(unresolvedRow?.resolution_hint).not.toHaveProperty("edition_id")

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 0, p_rows_skipped: 2 })
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
  })

  it("Cadence borrow fallback ([editionID, serial] UInt64 shape) resolves the edition and persists nft_edition_map", async () => {
    const tx = "6".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x3333333333333333", priceDuc: 25, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: CEILING - 160, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("606", "813", true, GOLAZOS_NFT) })],
        scripts: [cdcUInt64Array(["901", "7"])],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-901", external_id: "901" }], error: null },
    })

    await POST(req())

    const mapUpsert = (spy.writes.nft_edition_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows[0]).toEqual({
      collection_id: GOLAZOS,
      nft_id: "606",
      edition_external_id: "901",
      serial_number: 7,
    })
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-901",
      nft_id: "606",
      price_usd: 25,
      serial_number: 7, // the borrow-resolved serial, not 0
      source: "onchain_dapper_v1",
      buyer_address: "0x3333333333333333",
    })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_rows_skipped: 0 })
    expect(log?.p_extra).toMatchObject({ cadence_attempts: 1, editions_resolved: 1 })
    // The borrow candidates came from the decoded buyer — no tx-participant fetch.
    expect(fetchMock!.calls.filter((c) => c.url.includes("/v1/transactions/"))).toHaveLength(0)
    expect(fetchMock!.calls.filter((c) => c.url.includes("/v1/scripts"))).toHaveLength(1)
  })

  it("a fatal error mid-run logs ok=false, still fires the finally-promote, and 500s", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: cursorFixture }, { failWrites: ["event_cursor"] })

    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("event_cursor")

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("event_cursor")
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
  })
})

describe("golazos-sales-history-backfill — dryRun probe", () => {
  it("scans + decodes a sample but writes NOTHING and logs nothing", async () => {
    const tx = "7".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0909090909090909", seller: "0x0a0a0a0a0a0a0a0a", priceDuc: 42, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: CEILING - 140, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "814", true, GOLAZOS_NFT) })],
      }),
    )
    const spy = install({})

    const res = await POST(req(`?dryRun=true&range=250&ceiling=${CEILING}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      scanned: `${START}-${CEILING - 1}`,
      blocks: 250,
      found: 1,
      belowFloor: false,
    })
    expect(body.sample[0]).toMatchObject({
      src: "v1_dapper",
      nft: "555",
      price: 42,
      certain: true,
      buyer: "0x0909090909090909",
      seller: "0x0a0a0a0a0a0a0a0a",
    })
    // dryRun is a pure probe: no cursor, no sales, no pipeline_runs, no promote.
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
  })
})
