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
  V2_FLOWTY_LISTING_COMPLETED,
} from "./helpers/flow-cdc-fixture"

// Deep-drive of /api/cron/topshot-flowty-sales-history-backfill — the SINGLE-
// SOURCE backward walker over the Flowty fork, filtered to TopShot. Pinned
// contracts (incl. sibling drift):
//   - every resolved sale is tagged marketplace 'flowty' + source 'onchain'
//     with price inline from the event (NO price-uncertain concept — DRIFT vs
//     the v1-dapper walkers) and block_height SET (the revert key);
//   - buyer/seller come from decodeTopShotSaleTx (the event's own buyer is the
//     fee router), edition resolution is holder-independent getMintedMoment;
//   - the CANONICAL_KEY guard REJECTS uuid-form wmc edition keys (the inert-dupe
//     class) — a uuid-keyed wmc row must fall through to the GQL fallback;
//   - first-init cursor: no cursor row -> block-bisect of the 2026-04-01
//     ceiling; a bisect converging at the spork floor short-circuits inert; a
//     bisect FAILURE logs ok=false and returns 200 (not a crash-500);
//   - unresolvable sales land in unmapped_sales with
//     resolution_hint.backfill='topshot_flowty_history';
//   - fatal errors still run the finally-promote, log ok=false, and 500;
//   - dryRun probes (incl. getMinted samples) but writes/logs nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  decodeByTx: {} as Record<string, { buyer?: string | null; seller?: string | null; throwMsg?: string }>,
  decodeCalls: [] as Array<{ tx: string; nftId: string }>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeTopShotSaleTx: async (tx: string, nftId: string) => {
    state.decodeCalls.push({ tx, nftId })
    const d = state.decodeByTx[tx] ?? {}
    if (d.throwMsg) throw new Error(d.throwMsg)
    return { buyer: d.buyer ?? null, seller: d.seller ?? null, payer: null, proposer: null, ok: true }
  },
}))

process.env.INGEST_SECRET_TOKEN = "flowty-history-token"
const { POST } = await import("@/app/api/cron/topshot-flowty-sales-history-backfill/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TOPSHOT_NFT = "A.0b2a3299cc857e29.TopShot.NFT"
const CURSOR_ID = "topshot_flowty_backfill"
const SPORK_FLOOR = 137_390_146
const CEILING = 149_000_000
const START = CEILING - 250
const PROXY = "https://ts-proxy.test/graphql"

function flowtySale(nftId: string, price: string, txId: string, height: number, typeID = TOPSHOT_NFT) {
  return eventBlock({
    height,
    txId,
    eventType: V2_FLOWTY_LISTING_COMPLETED,
    payload: cdcEvent(V2_FLOWTY_LISTING_COMPLETED, {
      listingResourceID: cdc.uint64(9300 + (Number(nftId) % 1000)),
      storefrontResourceID: cdc.uint64(3),
      purchased: cdc.bool(true),
      nftType: cdc.nftType(typeID),
      nftID: cdc.uint64(nftId),
      salePrice: cdc.ufix64(price),
      customID: cdc.optionalNull(),
    }),
  })
}

/** getMintedMoment responder keyed by the momentId in the GQL variables. */
function getMintedStub(
  byId: Record<string, { setFlowId: number | string; playFlowId: string; serial: string } | null>,
): FetchStub {
  return {
    match: (url) => url.includes("ts-proxy.test"),
    respond: (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { id?: string } }
      const hit = byId[body.variables?.id ?? ""]
      if (!hit) return { json: { data: { getMintedMoment: { data: null } } } }
      return {
        json: {
          data: {
            getMintedMoment: {
              data: {
                flowSerialNumber: hit.serial,
                play: { flowID: hit.playFlowId },
                set: { flowId: hit.setFlowId },
              },
            },
          },
        },
      }
    },
  }
}

function flowStubs(opts: {
  events?: unknown[]
  getMinted?: Record<string, { setFlowId: number | string; playFlowId: string; serial: string } | null>
  sealedHeight?: number
  sealedStatus?: number
  blockTimestamp?: string
}): FetchStub[] {
  const stubs: FetchStub[] = [
    getMintedStub(opts.getMinted ?? {}),
    {
      match: (url) => url.includes("/v1/blocks?height=sealed"),
      respond: () =>
        opts.sealedStatus
          ? { status: opts.sealedStatus, ok: false, text: "boom" }
          : { json: [{ header: { height: String(opts.sealedHeight ?? SPORK_FLOOR + 1) } }] },
    },
    jsonRoute("/v1/blocks?height=", [{ header: { timestamp: opts.blockTimestamp ?? "2026-05-01T00:00:00Z" } }]),
    jsonRoute("A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted", opts.events ?? []),
  ]
  return stubs
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures, opts: { failWrites?: string[] } = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures, opts)
  state.sb = spy.fixture
  return spy
}

function req(qs = "?range=250", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/topshot-flowty-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer flowty-history-token" }),
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
  process.env.INGEST_SECRET_TOKEN = "flowty-history-token"
  process.env.TS_PROXY_URL = PROXY
  delete process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
  state.decodeByTx = {}
  state.decodeCalls = []
})

describe("topshot-flowty-sales-history-backfill — control paths", () => {
  it("401s without any token; the kill-switch (via the CRON ?token= lane) logs an honest ok run", async () => {
    const spy = install({})
    expect((await POST(req("?range=250", {}))).status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.CRON_SECRET = "vercel-cron-secret"
    process.env.TOPSHOT_FLOWTY_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(req("?range=250&token=vercel-cron-secret", {}))
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "nba_top_shot" })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("self-throttles on platform saturation before any cursor/bisect work", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 20 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 20 })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).skipped).toBe("saturation")
  })

  it("first-init bisect that converges at the spork floor parks the run inert (no scan, no promote, no cursor write)", async () => {
    // No cursor row -> bisect. sealed = floor+1 and every timestamp >= the
    // 2026-04-01 target, so the search converges to lo = SPORK_FLOOR.
    fetchMock = installFetchMock(flowStubs({}))
    const spy = install({
      event_cursor: { data: null, error: null },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, note: "reached_spork_floor", floor: SPORK_FLOOR })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_cursor_before: String(SPORK_FLOOR),
      p_cursor_after: String(SPORK_FLOOR),
    })
    expect((log?.p_extra as Record<string, unknown>).note).toBe("reached_spork_floor_hint")
    expect(spy.rpcCalls.some((c) => c.name === "promote_unmapped_sales")).toBe(false)
    expect(spy.writes.event_cursor ?? []).toHaveLength(0)
    expect(fetchMock.calls.filter((c) => c.url.includes("/v1/events"))).toHaveLength(0)
  })

  it("a bisect FAILURE logs ok=false and returns 200 bisect_failed (a soft park, not a crash)", async () => {
    fetchMock = installFetchMock(flowStubs({ sealedStatus: 500 }))
    const spy = install({ event_cursor: { data: null, error: null } })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, error: "bisect_failed" })
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toMatch(/^bisect_failed: /)
  })
})

describe("topshot-flowty-sales-history-backfill — scan + write", () => {
  it("ingests TS Flowty sales: canonical wmc key accepted, uuid wmc key REJECTED (getMinted fallback + nft_edition_map), decode parties, cursor + promote", async () => {
    const txA = "1".repeat(64)
    const txB = "2".repeat(64)
    state.decodeByTx[txA] = { buyer: "0x0101010101010101", seller: "0x0202020202020202" }
    state.decodeByTx[txB] = { buyer: "0x0303030303030303" }
    fetchMock = installFetchMock(
      flowStubs({
        events: [
          flowtySale("111", "20.00000000", txA, CEILING - 200),
          flowtySale("222", "7.50000000", txB, CEILING - 150),
          // A Golazos NFT on the fork — filtered before accounting.
          flowtySale("999", "1.00000000", "9".repeat(64), CEILING - 149, "A.87ca73a41bb50ad5.Golazos.NFT"),
        ],
        getMinted: { "222": { setFlowId: 14, playFlowId: "400", serial: "9" } },
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: {
        data: [
          { moment_id: "111", edition_key: "12:345", serial_number: 7 },
          // uuid-form key = inert dupe — the CANONICAL_KEY guard must reject it.
          { moment_id: "222", edition_key: "d290f1ee-6c54-4b01-90e6-d701748f0851", serial_number: null },
        ],
        error: null,
      },
      nft_edition_map: { data: [], error: null },
      editions: {
        data: [
          { id: "uuid-a", external_id: "12:345" },
          { id: "uuid-b", external_id: "14:400" },
        ],
        error: null,
      },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // The GQL fallback fired ONLY for the uuid-rejected nft.
    const gqlCalls = fetchMock.calls.filter((c) => c.url.includes("ts-proxy.test"))
    expect(gqlCalls).toHaveLength(1)
    expect(JSON.parse(String(gqlCalls[0].init?.body)).variables).toEqual({ id: "222" })
    // ...and was persisted for future ticks.
    const mapUpsert = (spy.writes.nft_edition_map ?? []).find((w) => w.method === "upsert")
    expect(mapUpsert?.rows).toEqual([
      { collection_id: TS, nft_id: "222", edition_external_id: "14:400", serial_number: 9 },
    ])

    expect(state.decodeCalls).toEqual([
      { tx: txA, nftId: "111" },
      { tx: txB, nftId: "222" },
    ])
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(2)
    expect(saleRows.find((r) => r.nft_id === "111")).toMatchObject({
      edition_id: "uuid-a",
      collection_id: TS,
      collection: "nba_top_shot",
      price_usd: 20,
      serial_number: 7,
      marketplace: "flowty",
      source: "onchain",
      block_height: CEILING - 200, // SET — the revert key vs the forward indexer's NULLs
      transaction_hash: txA,
      buyer_address: "0x0101010101010101",
      seller_address: "0x0202020202020202",
    })
    expect(saleRows.find((r) => r.nft_id === "222")).toMatchObject({
      edition_id: "uuid-b",
      price_usd: 7.5,
      serial_number: 9, // from getMinted, not wmc
      buyer_address: "0x0303030303030303",
      seller_address: null,
    })
    expect(spy.writes.unmapped_sales ?? []).toHaveLength(0)

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
      p_collection_slug: "nba_top_shot",
    })
    expect(log?.p_extra).toMatchObject({
      scanned: `${START}-${CEILING - 1}`,
      ceiling: CEILING,
      get_minted_used: 1,
      tx_decoded: 2,
      editions_resolved: 1,
      raw: 3,
      tsIn: 2,
    })
    expect(spy.rpcCalls.find((c) => c.name === "promote_unmapped_sales")?.args).toEqual({ p_collection_id: TS })
    expect(await res.json()).toMatchObject({ ok: true, found: 2, sales_written: 2, next_ceiling: START })
  })

  it("an unresolvable sale lands in unmapped_sales with the topshot_flowty_history hint and its inline price intact", async () => {
    const tx = "5".repeat(64)
    state.decodeByTx[tx] = { buyer: "0x0707070707070707" }
    fetchMock = installFetchMock(
      flowStubs({
        events: [flowtySale("333", "11.25000000", tx, CEILING - 120)],
        getMinted: { "333": null }, // GQL cannot resolve it either
      }),
    )
    const spy = install({
      event_cursor: cursorFixture,
      wallet_moments_cache: { data: [], error: null },
      nft_edition_map: { data: [], error: null },
      editions: { data: [], error: null },
    })

    await POST(req())

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.nft_edition_map ?? []).toHaveLength(0)
    const unmapped = (spy.writes.unmapped_sales ?? []).flatMap((w) => w.rows)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]).toMatchObject({
      collection_id: TS,
      nft_id: "333",
      serial_number: 0,
      price_usd: 11.25, // inline flowty price is trusted even when unmapped
      marketplace: "flowty",
      source: "onchain",
      block_height: CEILING - 120,
      buyer_address: "0x0707070707070707",
    })
    expect(unmapped[0].resolution_hint).toEqual({
      nft_id: "333",
      sale_source: "v2_flowty",
      backfill: "topshot_flowty_history",
    })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 1, p_rows_written: 0, p_rows_skipped: 1 })
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

describe("topshot-flowty-sales-history-backfill — dryRun probe", () => {
  it("scans + samples via getMinted but writes NOTHING, logs nothing, promotes nothing", async () => {
    fetchMock = installFetchMock(
      flowStubs({
        events: [flowtySale("444", "3.00000000", "7".repeat(64), CEILING - 110)],
        getMinted: { "444": { setFlowId: 12, playFlowId: "345", serial: "88" } },
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
      ceiling: CEILING,
      found: 1,
      belowFloor: false,
    })
    expect(body.sample[0]).toMatchObject({
      nft: "444",
      price: "3.00000000",
      edition: "12:345",
      serial: 88,
    })
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
  })
})
