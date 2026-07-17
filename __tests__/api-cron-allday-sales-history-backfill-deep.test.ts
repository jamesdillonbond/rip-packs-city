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
  V1_LISTING_COMPLETED,
  V2_FLOWTY_LISTING_COMPLETED,
  v1SalePayload,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/cron/allday-sales-history-backfill — the BACKWARD walker
// that owns the pre-indexer block range (< 148,653,524) exclusively. The route
// is SYNCHRONOUS; fixtures feed the real scan body Flow-REST JSON-CDC bytes so
// the inline unwrapCdc / extractNftTypeId / venue-classification code runs
// unmodified. Pinned contracts:
//   - venue drift: v1_dapper -> marketplace 'nflallday' + source
//     'onchain_dapper_v1' (price from decodeV1SaleTx, DUC-certain only);
//     v2_flowty -> 'flowty' + 'onchain' (price inline, NO decode call);
//     non-AllDay nftTypes are filtered before any accounting;
//   - the BACKWARD cursor: advances DOWN to `ceiling - scanWindow` and is
//     clamped at the spork floor; cursor_before/after land in pipeline_runs;
//   - price-uncertain and unresolvable sales go to unmapped_sales with their
//     resolution_hint (counted as rows_skipped, never as sales);
//   - the Cadence borrow fallback resolves nftID -> edition, persists the
//     nft_edition_map row, and the on-chain GET_EDITION_DATA hydration path
//     (buildOnChainEditionRow) creates the missing edition before the sale lands;
//   - floor semantics: dynamic below-floor 404 detection stops the scan but
//     still advances + logs; a cursor already at the floor short-circuits
//     WITHOUT promote/chain (deeper history is spork-proxy territory);
//   - a fatal error still runs the finally-promote, logs ok=false, and 500s;
//   - dryRun writes nothing, logs nothing, chains nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
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
  decodeCalls: [] as Array<{ tx: string; nftId: string }>,
  hydrateResults: [] as Array<{ ok: boolean; external_id: string }>,
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
vi.mock("@/lib/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string, opts: { nftId: string }) => {
    state.decodeCalls.push({ tx, nftId: opts.nftId })
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
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateAllDayEditions: async (_ids: string[]) => state.hydrateResults,
  toUpsertRow: (r: { external_id: string }) => ({
    external_id: r.external_id,
    collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070",
    name: "Hydrated Edition",
  }),
}))

// TOKEN is captured into a module const at import time — set env FIRST.
process.env.INGEST_SECRET_TOKEN = "history-token"
const { POST } = await import("@/app/api/cron/allday-sales-history-backfill/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALLDAY_NFT = "A.e4cf4bdc1751c65d.AllDay.NFT"
const CURSOR_ID = "allday_sales_v1_backfill"
const SPORK_FLOOR = 137_390_146
// Default test window: ceiling 137,400,000 with ?range=250 -> ONE 250-block
// chunk [137,399,750 .. 137,399,999] -> exactly one fetch per event source.
const CEILING = 137_400_000
const START = CEILING - 250

/** V2 Flowty ListingCompleted purchase payload (carries price+parties inline). */
function v2FlowtySalePayload(
  nftId: string,
  price: string,
  opts: { buyer?: string; storefrontAddress?: string; typeID?: string } = {},
) {
  return cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
    listingResourceID: cdc.uint64(9000 + (Number(nftId) % 1000)),
    storefrontResourceID: cdc.uint64(3),
    purchased: cdc.bool(true),
    nftType: cdc.nftType(opts.typeID ?? ALLDAY_NFT),
    nftID: cdc.uint64(nftId),
    salePrice: cdc.ufix64(price),
    storefrontAddress: { type: "Address", value: opts.storefrontAddress ?? "0xaaaaaaaaaaaaaaaa" },
    buyer: { type: "Address", value: opts.buyer ?? "0xbbbbbbbbbbbbbbbb" },
    customID: cdc.optionalNull(),
  })
}

function flowStubs(events: {
  v1?: unknown[]
  v2Flowty?: unknown[]
  v1Response?: { status: number; text: string }
  scripts?: Array<{ value: string }>
}): FetchStub[] {
  let scriptCall = 0
  const stubs: FetchStub[] = [
    {
      match: (url) => url.includes("/v1/scripts"),
      respond: () => {
        const r = events.scripts?.[Math.min(scriptCall, (events.scripts?.length ?? 1) - 1)]
        scriptCall++
        return { json: r ?? scriptResult(null) }
      },
    },
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", events.v2Flowty ?? []),
    jsonRoute("A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted", []),
  ]
  if (events.v1Response) {
    stubs.push({
      match: (url) => url.includes("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted"),
      respond: () => ({ status: events.v1Response!.status, ok: false, text: events.v1Response!.text }),
    })
  } else {
    stubs.push(jsonRoute("A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted", events.v1 ?? []))
  }
  return stubs
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/allday-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer history-token" }),
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
  process.env.INGEST_SECRET_TOKEN = "history-token"
  delete process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.chained.length = 0
  state.decodeByTx = {}
  state.decodeCalls = []
  state.hydrateResults = []
})

describe("allday-sales-history-backfill — control paths", () => {
  it("401s without any token; accepts CRON_SECRET via ?token= (the Vercel-cron dual-auth lane)", async () => {
    const spy = install({})
    const res = await POST(req("?range=250", {}))
    expect(res.status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    // ?token=CRON_SECRET must authenticate; kill-switch short-circuits the body
    // so this stays a pure auth probe.
    process.env.CRON_SECRET = "vercel-cron-secret"
    process.env.ALLDAY_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res2 = await POST(req("?range=250&token=vercel-cron-secret", {}))
    expect(res2.status).toBe(200)
    expect(await res2.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("self-throttles on platform saturation and logs the skip", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 16 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 16 })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).skipped).toBe("saturation")
    // Throttle fires before any chain scan or cursor movement.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(state.chained).toHaveLength(0)
  })

  it("a cursor at the spork floor short-circuits: logged as reached_spork_floor_hint with NO promote, NO chain, NO cursor write", async () => {
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
    // Deeper history is spork-proxy territory — the terminal state must be inert.
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(false)
    expect(state.chained).toHaveLength(0)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
  })
})

describe("allday-sales-history-backfill — scan + write", () => {
  it("ingests V1 (decoded) + V2 Flowty (inline) sales with correct venue tags, filters non-AllDay types, advances the backward cursor, logs + chains", async () => {
    const txV1 = "1".repeat(64)
    const txFlowty = "2".repeat(64)
    state.decodeByTx[txV1] = {
      buyer: "0x0101010101010101",
      seller: "0x0202020202020202",
      priceDuc: 42,
      priceCertain: true,
    }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [
          eventBlock({ height: 137_399_800, txId: txV1, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "801", true, ALLDAY_NFT) }),
        ],
        v2Flowty: [
          eventBlock({ height: 137_399_900, txId: txFlowty, eventType: V2_FLOWTY_LISTING_COMPLETED, payload: v2FlowtySalePayload("666", "9.50000000") }),
          // A TopShot NFT on the Flowty fork — must be filtered before accounting.
          eventBlock({ height: 137_399_901, txId: "3".repeat(64), eventType: V2_FLOWTY_LISTING_COMPLETED, payload: v2FlowtySalePayload("999", "1.00000000", { typeID: "A.0b2a3299cc857e29.TopShot.NFT" }) }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: {
        data: [
          { moment_id: "555", edition_key: "901", serial_number: 12 },
          { moment_id: "666", edition_key: "902", serial_number: 34 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "uuid-901", external_id: "901" },
          { id: "uuid-902", external_id: "902" },
        ],
        error: null,
      },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // Only the flowty-side sales carry inline price; V1 price came from decode.
    expect(state.decodeCalls).toEqual([{ tx: txV1, nftId: "555" }])
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(2)
    const v1Row = saleRows.find((r) => r.nft_id === "555")
    expect(v1Row).toMatchObject({
      edition_id: "uuid-901",
      collection_id: ALLDAY,
      collection: "nfl_all_day",
      price_usd: 42,
      serial_number: 12,
      marketplace: "nflallday",
      source: "onchain_dapper_v1",
      block_height: 137_399_800,
      transaction_hash: txV1,
      buyer_address: "0x0101010101010101",
      seller_address: "0x0202020202020202",
    })
    const flowtyRow = saleRows.find((r) => r.nft_id === "666")
    expect(flowtyRow).toMatchObject({
      edition_id: "uuid-902",
      price_usd: 9.5,
      serial_number: 34,
      marketplace: "flowty",
      source: "onchain",
      buyer_address: "0xbbbbbbbbbbbbbbbb",
      seller_address: "0xaaaaaaaaaaaaaaaa",
    })
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

    // Backward cursor: the new LOW is ceiling - scanWindow.
    const cursorUpsert = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ id: CURSOR_ID, last_processed_block: START })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 2, // the TopShot-typed event never entered the sale set
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_cursor_before: String(CEILING),
      p_cursor_after: String(START),
      p_collection_slug: "nfl_all_day",
    })
    expect(log?.p_extra).toMatchObject({
      scanned: `${START}-${CEILING - 1}`,
      blocks: 250,
      v1_decoded: 1,
      below_floor: false,
      rawV1: 1,
      v1In: 1,
      rawV2Flowty: 2,
      v2FlowtyIn: 1,
    })
    expect(spy.rpcCalls.find((c) => c.name === "promote_unmapped_sales")?.args).toEqual({ p_collection_id: ALLDAY })
    expect(state.chained).toEqual([{ path: "/api/cron/allday-resolve-unmapped", chain: true }])
    expect(await res.json()).toMatchObject({
      ok: true,
      found: 2,
      sales_written: 2,
      unmapped_written: 0,
      below_floor: false,
      next_ceiling: START,
    })
  })

  it("price-uncertain and unresolvable sales land in unmapped_sales with their resolution_hints, counted as skipped", async () => {
    const txUncertain = "4".repeat(64)
    const txUnmapped = "5".repeat(64)
    // 701: edition resolves but the DUC split is ambiguous -> price uncertain.
    state.decodeByTx[txUncertain] = {
      buyer: "0x0505050505050505",
      seller: "0x0606060606060606",
      priceCertain: false,
      priceReason: "multiple_duc_transfers",
      sampleAmounts: [10, 90],
    }
    // 702: price certain but nothing resolves it (no buyer, tx lookup empty).
    state.decodeByTx[txUnmapped] = { buyer: null, seller: null, priceDuc: 10, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [
          eventBlock({ height: 137_399_810, txId: txUncertain, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("701", "811", true, ALLDAY_NFT) }),
          eventBlock({ height: 137_399_820, txId: txUnmapped, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("702", "812", true, ALLDAY_NFT) }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [{ moment_id: "701", edition_key: "901", serial_number: 4 }], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [{ id: "uuid-901", external_id: "901" }], error: null },
    })

    await POST(req())

    // Even a RESOLVED edition never reaches `sales` with an uncertain price.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(2)
    const uncertainRow = unmapped.find((r) => r.nft_id === "701")
    expect(uncertainRow).toMatchObject({
      collection_id: ALLDAY,
      price_usd: 0, // uncertain price is NEVER guessed
      source: "onchain_dapper_v1",
      marketplace: "nflallday",
      buyer_address: "0x0505050505050505",
    })
    expect(uncertainRow?.resolution_hint).toMatchObject({
      nft_id: "701",
      sale_source: "v1_dapper",
      backfill: "allday_v1_history",
      edition_id: "901", // the resolved key rides along for the promoter
      price_extraction: "multiple_duc_transfers",
      sample_duc_amounts: [10, 90],
    })
    const unresolvedRow = unmapped.find((r) => r.nft_id === "702")
    expect(unresolvedRow).toMatchObject({ price_usd: 10, serial_number: 0 })
    expect(unresolvedRow?.resolution_hint).not.toHaveProperty("edition_id")

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 0, p_rows_skipped: 2 })
  })

  it("Cadence borrow fallback resolves the edition, persists nft_edition_map, and the on-chain hydration path creates the missing edition row", async () => {
    const tx = "6".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x3333333333333333", seller: null, priceDuc: 25, priceCertain: true }
    // hydrateAllDayEditions misses -> the GET_EDITION_DATA on-chain script fills in.
    state.hydrateResults = [{ ok: false, external_id: "901" }]
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: 137_399_830, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("606", "813", true, ALLDAY_NFT) })],
        scripts: [
          // 1) buyer-wallet borrow resolves edition 901, serial 7
          scriptResult({ id: "606", editionID: "901", serialNumber: "7", mintingDate: "1700000000.0" }),
          // 2) AllDay.getEditionData for the missing edition
          scriptResult({
            playID: "10",
            setID: "20",
            tier: "RARE",
            maxMintSize: "100",
            numMinted: "50",
            playerName: "Foo Bar",
            teamName: "Ravens",
            setName: "Base Set",
            seriesID: "3",
            playType: "Rush",
            dateOfMoment: "2023-10-01 00:00:00",
            homeTeamName: "BAL",
            awayTeamName: "PIT",
          }),
        ],
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: [
        { data: [], error: null }, // key->uuid lookup: miss
        { data: [{ id: "uuid-901", external_id: "901" }], error: null }, // upsert .select() return
      ],
    })

    await POST(req())

    // The borrow result was persisted for future ticks.
    const mapUpsert = (spy.writes.nft_edition_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows[0]).toMatchObject({
      collection_id: ALLDAY,
      nft_id: "606",
      edition_external_id: "901",
      serial_number: 7,
    })
    // buildOnChainEditionRow shape — the on-chain hydration contract (max mint
    // wins over numMinted for circulation; composed name; normalized tier).
    const edUpsert = (spy.writes.editions ?? []).find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({
      external_id: "901",
      collection_id: ALLDAY,
      collection: "nfl_all_day",
      name: "Foo Bar — Base Set",
      player_name: "Foo Bar",
      set_name: "Base Set",
      team_name: "Ravens",
      tier: "RARE",
      series: 3,
      circulation_count: 100,
      set_id_onchain: 20,
      play_id_onchain: 10,
      play_type: "Rush",
      game_date: "2023-10-01",
      home_team: "BAL",
      away_team: "PIT",
    })
    // ...and the sale landed on the freshly-created edition uuid.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-901",
      nft_id: "606",
      price_usd: 25,
      serial_number: 7,
      source: "onchain_dapper_v1",
      buyer_address: "0x3333333333333333",
    })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_rows_skipped: 0 })
    expect(log?.p_extra).toMatchObject({ cadence_attempts: 1, editions_resolved: 1 })
  })

  it("a below-spork-floor 404 stops the scan gracefully: below_floor surfaced, cursor still advances, run stays ok", async () => {
    fetchMock = installFetchMock(
      flowStubs({
        v1Response: { status: 404, text: "requested start height 137399750 is less than the spork root block height" },
      }),
    )
    const spy = install({ event_cursor: cursorFixture })

    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, found: 0, below_floor: true, next_ceiling: START })

    const cursorUpsert = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ id: CURSOR_ID, last_processed_block: START })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect((log?.p_extra as Record<string, unknown>).below_floor).toBe(true)
  })

  it("a fatal error mid-run logs ok=false, still fires the finally-promote + chain, and 500s", async () => {
    fetchMock = installFetchMock(flowStubs({}))
    // The cursor upsert throws -> the catch owns the error; finally must still run.
    const spy = install({ event_cursor: cursorFixture }, { failWrites: ["event_cursor"] })

    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("event_cursor")

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toContain("event_cursor")
    // The promote + resolve-unmapped chain are unconditional on failure — a
    // partial write set still gets drained.
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(true)
    expect(state.chained).toEqual([{ path: "/api/cron/allday-resolve-unmapped", chain: true }])
  })
})

describe("allday-sales-history-backfill — dryRun probe", () => {
  it("scans + decodes a sample but writes NOTHING, logs nothing, chains nothing", async () => {
    const tx = "7".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0909090909090909", priceDuc: 42, priceCertain: true }
    fetchMock = installFetchMock(
      flowStubs({
        v1: [eventBlock({ height: 137_399_840, txId: tx, eventType: V1_LISTING_COMPLETED, payload: v1SalePayload("555", "814", true, ALLDAY_NFT) })],
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
    })
    // dryRun is a pure probe: no cursor, no sales, no pipeline_runs, no chain.
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
    expect(state.chained).toHaveLength(0)
  })
})
