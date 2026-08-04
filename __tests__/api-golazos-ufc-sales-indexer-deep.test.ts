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
  eventBlock,
  v2DapperSalePayload,
  V1_LISTING_COMPLETED,
  V2_DAPPER_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of the Golazos + UFC sales indexers — structural siblings of the
// AllDay indexer (same three-storefront scan, same enrichment ladder) with
// per-collection venue tags and NFT-type filters. One happy path + the
// wrong-collection filter each, pinning the venue/collection constants that a
// copy-paste drift would silently corrupt:
//   golazos: .Golazos.NFT -> marketplace 'laligagolazos', collection laliga_golazos
//   ufc:     .UFC_NFT.NFT -> marketplace 'ufcstrike',     collection ufc_strike

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null }>,
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
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeV1SaleTx: async (tx: string) => {
    const d = state.decodeByTx[tx] ?? {}
    return {
      buyer: d.buyer ?? null,
      seller: d.seller ?? null,
      priceDuc: null,
      priceCertain: false,
      priceReason: "no_duc_transfer",
      sampleAmounts: [],
    }
  },
}))

process.env.INGEST_SECRET_TOKEN = "sibling-token"

const golazos = await import("@/app/api/golazos-sales-indexer/route")
const ufc = await import("@/app/api/ufc-sales-indexer/route")

const GOLAZOS_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const UFC_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

// Sealed height 1250 + cursor 1000 -> one 250-block chunk; each fixture lands once.
function flowRestStubs(v2Dapper: unknown[]): FetchStub[] {
  return [
    jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
    jsonRoute("/v1/scripts", { value: "" }),
    jsonRoute(encodeURIComponent(V2_DAPPER_LISTING_COMPLETED), v2Dapper),
    jsonRoute(encodeURIComponent(V1_LISTING_COMPLETED), []),
    jsonRoute("/v1/events", []),
    jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
  ]
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(path: string): NextRequest {
  return new NextRequest(`https://t${path}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer sibling-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function terminalLog(rpcCalls: RecordedRpcCall[], pipeline: string) {
  return rpcCalls
    .filter((c) => c.name === "log_pipeline_run" && c.args?.p_pipeline === pipeline)
    .at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "sibling-token"
  state.afterCbs.length = 0
  state.chained.length = 0
  state.decodeByTx = {}
})

describe("golazos-sales-indexer", () => {
  it("ingests a Golazos V2 Dapper sale with the laligagolazos venue tag", async () => {
    const tx1 = "5".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x1010101010101010", seller: "0x2020202020202020" }
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1100,
          txId: tx1,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("444", "9.99000000", "A.87ca73a41bb50ad5.Golazos.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "444", edition_key: "55" }],
        error: null,
      },
      editions: { data: [{ id: "uuid-g55", external_id: "55" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await golazos.POST(req("/api/golazos-sales-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-g55",
      collection_id: GOLAZOS_ID,
      collection: "laliga_golazos",
      nft_id: "444",
      price_usd: 9.99,
      // wmc carries no serial for Golazos/UFC; the borrow fallback is the only
      // serial source here, and the sales-table trigger coerces 0 -> NULL.
      serial_number: 0,
      marketplace: "laligagolazos",
      source: "onchain_dapper_v2",
      buyer_address: "0x1010101010101010",
    })
    const log = terminalLog(spy.rpcCalls, "golazos-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_cursor_after: "1250" })
  })

  it("ignores non-Golazos NFT types on the shared storefront", async () => {
    const tx = "6".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1101,
          txId: tx,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("445", "1.00000000", "A.e4cf4bdc1751c65d.AllDay.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await golazos.POST(req("/api/golazos-sales-indexer"))
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls, "golazos-sales-indexer")).toMatchObject({ p_rows_found: 0 })
  })
})

describe("ufc-sales-indexer", () => {
  it("ingests a UFC V2 Dapper sale with the ufcstrike venue tag", async () => {
    const tx1 = "7".repeat(64)
    state.decodeByTx[tx1] = { buyer: "0x3030303030303030", seller: null }
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1102,
          txId: tx1,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("333", "4.20000000", "A.329feb3ab062d289.UFC_NFT.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "333", edition_key: "88" }],
        error: null,
      },
      editions: { data: [{ id: "uuid-u88", external_id: "88" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await ufc.POST(req("/api/ufc-sales-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-u88",
      collection_id: UFC_ID,
      collection: "ufc_strike",
      nft_id: "333",
      price_usd: 4.2,
      serial_number: 0,
      marketplace: "ufcstrike",
      source: "onchain_dapper_v2",
      buyer_address: "0x3030303030303030",
    })
    const log = terminalLog(spy.rpcCalls, "ufc-sales-indexer")
    expect(log).toMatchObject({ p_ok: true, p_rows_written: 1, p_cursor_after: "1250" })
  })

  it("ignores non-UFC NFT types and 401s without the token", async () => {
    const tx = "8".repeat(64)
    fetchMock = installFetchMock(
      flowRestStubs([
        eventBlock({
          height: 1103,
          txId: tx,
          eventType: V2_DAPPER_LISTING_COMPLETED,
          payload: v2DapperSalePayload("334", "1.00000000", "A.edf9df96c92f4595.Pinnacle.NFT"),
        }),
      ]),
    )
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await ufc.POST(req("/api/ufc-sales-indexer"))
    await runDeferred()
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls, "ufc-sales-indexer")).toMatchObject({ p_rows_found: 0 })

    const unauthorized = await ufc.POST(
      new NextRequest("https://t/api/ufc-sales-indexer", { method: "POST" }),
    )
    expect(unauthorized.status).toBe(401)
  })

  it("caps the cursor when a chunk fetch throws — no leapfrog past the failed chunk", async () => {
    // ufc-sales advances the cursor per-chunk inside the loop; a chunk fetch that
    // THROWS must break so a later chunk can't move the cursor past it. Here the
    // single chunk (1001-1250) throws before its per-chunk cursor update, so the
    // cursor is never written and the range is retried next tick.
    fetchMock = installFetchMock([
      jsonRoute("blocks?height=sealed", [{ header: { height: "1250" } }]),
      jsonRoute("/v1/scripts", { value: "" }),
      {
        match: (u) => u.includes(encodeURIComponent(V2_DAPPER_LISTING_COMPLETED)),
        respond: () => {
          throw new Error("ECONNRESET")
        },
      },
      jsonRoute(encodeURIComponent(V1_LISTING_COMPLETED), []),
      jsonRoute("/v1/events", []),
      jsonRoute("/v1/transactions/", { proposal_key: null, authorizers: [], payer: null }),
    ])
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      sales: { data: null, error: null },
    })

    const res = await ufc.POST(req("/api/ufc-sales-indexer"))
    expect(res.status).toBe(200)
    await runDeferred()

    // Cursor never advanced (no event_cursor write) → the failed chunk is retried
    // next tick instead of being silently leapfrogged.
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    const log = terminalLog(spy.rpcCalls, "ufc-sales-indexer")
    expect(log?.p_cursor_after).toBe("1000")
    expect((log?.p_extra as Record<string, unknown>)?.partial_scan).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Shared-body legs: the unmapped fallback, the 23505 all-or-nothing insert
// contract, the no-new-blocks short-circuit, and the cursor-read failure.
// These live in the ~550-line runIndexer shared by both siblings, so driving
// them once through UFC exercises the same code Golazos runs.
// ---------------------------------------------------------------------------

// The shared helper's failWrites THROWS; the route awaits `.insert()` and reads
// `{error}`, so a real 23505 has to RESOLVE with an error. Wrap insert locally:
// the first (batch) call returns the error, per-row retries succeed.
function withBatchInsertError(
  spy: ReturnType<typeof makeInstrumentedSupabaseFixture>,
  table: string,
  code: string,
) {
  const fixture = spy.fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = fixture.from.bind(fixture)
  let firstBatchSeen = false
  fixture.from = (t: string) => {
    const b = baseFrom(t)
    if (t === table) {
      const base = b.insert as (rows: unknown) => unknown
      b.insert = (rows: unknown) => {
        const isBatch = Array.isArray(rows)
        base(rows)
        if (isBatch && !firstBatchSeen) {
          firstBatchSeen = true
          return Promise.resolve({ data: null, error: { code, message: "duplicate key" } })
        }
        return Promise.resolve({ data: null, error: null })
      }
    }
    return b
  }
  return spy
}

const SIBLINGS = [
  {
    name: "ufc-sales-indexer",
    mod: () => ufc,
    path: "/api/ufc-sales-indexer",
    nftType: "A.329feb3ab062d289.UFC_NFT.NFT",
    collectionId: UFC_ID,
    venue: "ufcstrike",
    heightBase: 1200,
  },
  {
    name: "golazos-sales-indexer",
    mod: () => golazos,
    path: "/api/golazos-sales-indexer",
    nftType: "A.87ca73a41bb50ad5.Golazos.NFT",
    collectionId: GOLAZOS_ID,
    venue: "laligagolazos",
    heightBase: 1210,
  },
] as const

describe.each(SIBLINGS)("sales-indexer shared body — $name", (S) => {
  const saleFixture = (nftId: string, tx: string, height: number) =>
    flowRestStubs([
      eventBlock({
        height,
        txId: tx,
        eventType: V2_DAPPER_LISTING_COMPLETED,
        payload: v2DapperSalePayload(nftId, "5.00000000", S.nftType),
      }),
    ])

  it("parks a sale in unmapped_sales when the edition cannot be resolved", async () => {
    const tx = "a".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x4040404040404040", seller: null }
    fetchMock = installFetchMock(saleFixture("999", tx, S.heightBase + 0))
    // wmc + editions both empty and the Cadence borrow returns nothing → unmapped
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
    })

    await S.mod().POST(req(S.path))
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({
      nft_id: "999",
      collection_id: S.collectionId,
      marketplace: S.venue,
      buyer_address: "0x4040404040404040",
    })
    // parked rows count as skipped, not written
    expect(terminalLog(spy.rpcCalls, S.name)).toMatchObject({ p_rows_written: 0 })
  })

  it("falls through to a row-by-row retry when the sales batch insert returns 23505", async () => {
    // A batch insert is all-or-nothing: swallowing the dupe would discard every
    // co-batched NEW row permanently (the cursor advances regardless).
    const tx = "b".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x5050505050505050", seller: null }
    fetchMock = installFetchMock(saleFixture("777", tx, S.heightBase + 1))
    const spy = withBatchInsertError(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: { data: [{ moment_id: "777", edition_key: "88" }], error: null },
        editions: { data: [{ id: "uuid-u88", external_id: "88" }], error: null },
        sales: { data: null, error: null },
      }),
      "sales",
      "23505",
    )

    await S.mod().POST(req(S.path))
    await runDeferred()

    const inserts = spy.writes.sales ?? []
    // one rejected batch + one per-row retry
    expect(inserts.length).toBeGreaterThanOrEqual(2)
    expect(inserts.some((w) => !Array.isArray(w.rows) || w.rows.length === 1)).toBe(true)
    // the retried row still lands
    expect(terminalLog(spy.rpcCalls, S.name)).toMatchObject({ p_rows_written: 1 })
  })

  it("logs p_ok:false to pipeline_runs when the write body throws — a fatal must never report green", async () => {
    // The "green while blind" class the ledger keeps citing: a pipeline that
    // reports ok:true is not evidence it did its work. If the enrichment/write
    // body THROWS (here failWrites makes the sales insert throw — distinct from a
    // resolved 23505, which the row-by-row path handles), the fatal catch + the
    // finally block must still record the run as NOT ok with the error text, so
    // the failure surfaces in pipeline_runs rather than a silent ok:true. Every
    // other test in this file asserts the happy/partial legs; this pins the one
    // that keeps a fatal from masquerading as a healthy tick.
    const tx = "c".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x6060606060606060", seller: null }
    fetchMock = installFetchMock(saleFixture("555", tx, S.heightBase + 2))
    const spy = install(
      {
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: { data: [{ moment_id: "555", edition_key: "88" }], error: null },
        editions: { data: [{ id: "uuid-x88", external_id: "88" }], error: null },
        sales: { data: null, error: null },
      },
      { failWrites: ["sales"] },
    )

    // The two siblings surface a fatal differently — golazos defers the scan via
    // after() (200 + the fatal logged in the deferred body); ufc scans inline (a
    // 500 response). The pipeline_runs logging is the invariant either way, so we
    // don't over-fit the HTTP status.
    const res = await S.mod().POST(req(S.path))
    expect([200, 500]).toContain(res.status)
    await runDeferred()

    const log = terminalLog(spy.rpcCalls, S.name)
    expect(log?.p_ok).toBe(false)
    expect(log?.p_error).toBeTruthy()
    // The run is still logged (the finally block ran) — the whole point is that a
    // fatal is recorded, not swallowed into an unlogged crash.
    expect(log?.p_pipeline).toBe(S.name)
  })

  it("retries row-by-row on a NON-dupe batch error too", async () => {
    const tx = "c".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x6060606060606060", seller: null }
    fetchMock = installFetchMock(saleFixture("778", tx, S.heightBase + 2))
    const spy = withBatchInsertError(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        wallet_moments_cache: { data: [{ moment_id: "778", edition_key: "88" }], error: null },
        editions: { data: [{ id: "uuid-u88", external_id: "88" }], error: null },
        sales: { data: null, error: null },
      }),
      "sales",
      "08006", // connection failure, not a dupe
    )

    await S.mod().POST(req(S.path))
    await runDeferred()
    expect(terminalLog(spy.rpcCalls, S.name)).toMatchObject({ p_rows_written: 1 })
  })

  it("short-circuits when the cursor is already at the sealed height", async () => {
    fetchMock = installFetchMock(flowRestStubs([]))
    const spy = install({
      event_cursor: { data: { last_processed_block: 1250 }, error: null },
    })

    const res = await S.mod().POST(req(S.path))
    expect(res.status).toBe(200)
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(terminalLog(spy.rpcCalls, S.name)).toMatchObject({ p_rows_found: 0 })
  })

  it("starts from block 0 when no cursor row exists yet", async () => {
    fetchMock = installFetchMock(flowRestStubs([]))
    const spy = install({ event_cursor: { data: null, error: null } })

    const res = await S.mod().POST(req(S.path))
    expect(res.status).toBe(200)
    await runDeferred()
    expect(terminalLog(spy.rpcCalls, S.name)).toBeTruthy()
  })
})
