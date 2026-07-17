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

// Deep-drive of /api/cron/ufc-sales-history-backfill — the UFC sibling of the
// three-source backward walker. Structure mirrors golazos; the pinned contracts
// here focus on the UFC-SPECIFIC drift:
//   - nftType filter is the `.UFC_NFT.NFT` suffix; marketplace tag 'ufcstrike'
//     (flowty leg stays 'flowty'/'onchain');
//   - the Cadence borrow returns [name, maxStr, serial] STRINGS and the route
//     slugifies client-side (slug(editionName)-max, the seed-ufc-editions
//     derivation) — an empty max yields a suffix-less slug; an empty name
//     aborts the resolution entirely;
//   - unmapped rows carry resolution_hint.backfill='ufc_v1_history' (with the
//     slug riding along as edition_id when the borrow resolved but the editions
//     catalog missed);
//   - the decoder receives the UFC Deposit/Withdraw event types;
//   - fatal errors still run the finally-promote, log ok=false, and 500.

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

process.env.INGEST_SECRET_TOKEN = "ufc-history-token"
const { POST } = await import("@/app/api/cron/ufc-sales-history-backfill/route")

const UFC = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const UFC_NFT = "A.329feb3ab062d289.UFC_NFT.NFT"
const CURSOR_ID = "ufc_sales_v1_backfill"
const SPORK_FLOOR = 137_390_146
const CEILING = 148_500_000
const START = CEILING - 250

/** Encode a Cadence [String] script result the way Flow REST returns it. */
function cdcStringArray(values: string[]) {
  const node = { type: "Array", value: values.map((v) => ({ type: "String", value: v })) }
  return { value: Buffer.from(JSON.stringify(node)).toString("base64") }
}

function flowtyPayload(nftId: string, price: string, opts: { commission?: string; typeID?: string } = {}) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9200 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(opts.typeID ?? UFC_NFT),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    commissionReceiver: opts.commission
      ? { type: "Optional", value: { type: "Address", value: opts.commission } }
      : cdc.optionalNull(),
  })
}

function flowStubs(events: {
  v1?: unknown[]
  v2d?: unknown[]
  v2f?: unknown[]
  scripts?: Array<{ value: string }>
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
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
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
  return new NextRequest(`https://t/api/cron/ufc-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer ufc-history-token" }),
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
  process.env.INGEST_SECRET_TOKEN = "ufc-history-token"
  delete process.env.UFC_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("ufc-sales-history-backfill — control paths", () => {
  it("401s without any token; the disabled kill-switch (via the CRON ?token= lane) logs an honest ok run", async () => {
    const spy = install({})
    expect((await POST(req("?range=250", {}))).status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.CRON_SECRET = "vercel-cron-secret"
    process.env.UFC_SALES_HISTORY_BACKFILL_DISABLED = "true"
    const res = await POST(req("?range=250&token=vercel-cron-secret", {}))
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "ufc_strike" })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("a cursor at the spork floor short-circuits with NO promote and NO cursor write", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({
      event_cursor: { data: { last_processed_block: SPORK_FLOOR }, error: null },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, note: "reached_spork_floor", floor: SPORK_FLOOR })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_cursor_before: String(SPORK_FLOOR), p_cursor_after: String(SPORK_FLOOR) })
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(false)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
  })
})

describe("ufc-sales-history-backfill — scan + write", () => {
  it("ingests all three venues with 'ufcstrike'/'flowty' tags, UFC-suffix type filter, UFC decoder events, cursor + promote", async () => {
    const txV1 = "1".repeat(64)
    const txV2f = "3".repeat(64)
    state.decodeByTx[txV1] = {
      buyer: "0x0101010101010101",
      seller: "0x0202020202020202",
      priceDuc: 30,
      priceCertain: true,
    }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [
          eventBlock({ height: CEILING - 200, txId: txV1, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "901", true, UFC_NFT) }),
          // A Golazos NFT — must be filtered by the .UFC_NFT.NFT suffix check.
          eventBlock({ height: CEILING - 199, txId: "9".repeat(64), eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("998", "902", true, "A.87ca73a41bb50ad5.Golazos.NFT") }),
        ],
        v2f: [
          eventBlock({ height: CEILING - 100, txId: txV2f, eventType: V2_FLOWTY_LISTING_COMPLETED, payload: flowtyPayload("777", "5.25000000", { commission: "0xcccccccccccccccc" }) }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: {
        data: [
          { moment_id: "555", edition_key: "STRIKER-KO-500", serial_number: 12 },
          { moment_id: "777", edition_key: "GROUND-GAME-100", serial_number: 3 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "uuid-striker", external_id: "STRIKER-KO-500" },
          { id: "uuid-ground", external_id: "GROUND-GAME-100" },
        ],
        error: null,
      },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // The decoder is pointed at the UFC contract's Deposit/Withdraw events.
    expect(state.decodeCalls[0]).toMatchObject({
      tx: txV1,
      nftId: "555",
      deposit: "A.329feb3ab062d289.UFC_NFT.Deposit",
      withdraw: "A.329feb3ab062d289.UFC_NFT.Withdraw",
    })

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(2)
    expect(saleRows.find((r) => r.nft_id === "555")).toMatchObject({
      edition_id: "uuid-striker",
      collection_id: UFC,
      collection: "ufc_strike",
      price_usd: 30,
      serial_number: 12,
      marketplace: "ufcstrike",
      source: "onchain_dapper_v1",
      transaction_hash: txV1,
      buyer_address: "0x0101010101010101",
    })
    expect(saleRows.find((r) => r.nft_id === "777")).toMatchObject({
      edition_id: "uuid-ground",
      price_usd: 5.25,
      marketplace: "flowty",
      source: "onchain",
      buyer_address: "0xcccccccccccccccc",
    })

    const cursorUpsert = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ id: CURSOR_ID, last_processed_block: START })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 2,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_cursor_before: String(CEILING),
      p_cursor_after: String(START),
      p_collection_slug: "ufc_strike",
    })
    expect(log?.p_extra).toMatchObject({ rawV1: 2, v1In: 1, rawV2Flowty: 1, v2FlowtyIn: 1, v1_decoded: 1 })
    expect(spy.rpcCalls.find((c) => c.name === "promote_unmapped_sales")?.args).toEqual({ p_collection_id: UFC })
    expect(await res.json()).toMatchObject({ ok: true, found: 2, sales_written: 2, next_ceiling: START })
  })

  it("Cadence borrow slugifies [name, max, serial]: with-max and empty-max variants; catalog miss falls to unmapped WITH the slug hint", async () => {
    const txA = "6".repeat(64)
    const txB = "7".repeat(64)
    state.decodeByTx[txA] = { buyer: "0x3333333333333333", priceDuc: 25, priceCertain: true }
    state.decodeByTx[txB] = { buyer: "0x4444444444444444", priceDuc: 8, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [
          eventBlock({ height: CEILING - 160, txId: txA, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("606", "911", true, UFC_NFT) }),
          eventBlock({ height: CEILING - 159, txId: txB, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("607", "912", true, UFC_NFT) }),
        ],
        scripts: [
          // A: punctuation collapses to hyphens, max appended.
          cdcStringArray(["Main Event | Israel Adesanya", "500", "7"]),
          // B: empty max -> suffix-less slug.
          cdcStringArray(["Open Mat", "", "3"]),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      // Only A's slug exists in the catalog; B's borrow succeeds but misses.
      editions: { data: [{ id: "uuid-adesanya", external_id: "MAIN-EVENT-ISRAEL-ADESANYA-500" }], error: null },
    })

    await POST(req())

    // Both borrows persisted to nft_edition_map with the client-side slug keys.
    const mapUpsert = (spy.writes.nft_edition_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows).toEqual([
      { collection_id: UFC, nft_id: "606", edition_external_id: "MAIN-EVENT-ISRAEL-ADESANYA-500", serial_number: 7 },
      { collection_id: UFC, nft_id: "607", edition_external_id: "OPEN-MAT", serial_number: 3 },
    ])

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-adesanya",
      nft_id: "606",
      price_usd: 25,
      serial_number: 7,
    })
    // B: resolved slug but no editions row -> unmapped, slug rides in the hint.
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({ nft_id: "607", price_usd: 8 })
    expect(unmapped[0].resolution_hint).toMatchObject({
      nft_id: "607",
      sale_source: "v1_dapper",
      backfill: "ufc_v1_history",
      edition_id: "OPEN-MAT",
    })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 1, p_rows_skipped: 1 })
    expect(log?.p_extra).toMatchObject({ cadence_attempts: 2, editions_resolved: 2 })
  })

  it("price-uncertain V1 sales land in unmapped_sales with price 0 and the extraction reason", async () => {
    const tx = "4".repeat(64)
    state.decodeByTx[tx] = {
      buyer: "0x0505050505050505",
      priceCertain: false,
      priceReason: "multiple_duc_transfers",
      sampleAmounts: [5, 45],
    }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: CEILING - 150, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("701", "921", true, UFC_NFT) })],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [{ moment_id: "701", edition_key: "STRIKER-KO-500", serial_number: 4 }], error: null },
      editions: { data: [{ id: "uuid-striker", external_id: "STRIKER-KO-500" }], error: null },
    })

    await POST(req())

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({ price_usd: 0, marketplace: "ufcstrike", source: "onchain_dapper_v1" })
    expect(unmapped[0].resolution_hint).toMatchObject({
      backfill: "ufc_v1_history",
      edition_id: "STRIKER-KO-500",
      price_extraction: "multiple_duc_transfers",
      sample_duc_amounts: [5, 45],
    })
    expect(terminalLog(spy.rpcCalls)).toMatchObject({ p_rows_written: 0, p_rows_skipped: 1 })
  })

  it("a fatal error mid-run logs ok=false, still fires the finally-promote, and 500s", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({ event_cursor: cursorFixture }, { failWrites: ["event_cursor"] })

    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("event_cursor")
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
  })
})
