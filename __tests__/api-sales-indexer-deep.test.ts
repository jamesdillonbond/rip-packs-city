import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of POST /api/sales-indexer (TopShot on-chain sales). Captures
// after() and stubs fcl / the GQL proxy / Supabase so the real resolution
// ladder runs: wmc (4a) -> moments-with-canonical-guard (4b) -> GQL int-pair
// fallback with the ensure_topshot_edition_stub self-heal (4d) -> the F9
// parallel split guard (4e) -> tx buyer/exec decode -> insert + cursor. These
// pin the mis-attribution rules that caused real incidents: sales must NEVER
// key onto a UUID-dupe edition, and a confirmed parallel must land on its
// ::subID edition, not collide with the Standard printing.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
  sealedHeight: 1250,
  sealedThrows: false,
  eventsByType: {} as Record<string, unknown[]>,
  decodeByTx: {} as Record<
    string,
    { buyer?: string | null; seller?: string | null; payer?: string | null; proposer?: string | null }
  >,
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
vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (scope: { setTag: () => void }) => void) => cb({ setTag: () => {} }),
  captureException: () => {},
}))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeTopShotSaleTx: async (tx: string, _nftId: string) => {
    const d = state.decodeByTx[tx] ?? {}
    return {
      buyer: d.buyer ?? null,
      seller: d.seller ?? null,
      payer: d.payer ?? null,
      proposer: d.proposer ?? null,
    }
  },
}))
// fcl seam: send([descriptor]).then(decode). Descriptors carry what was asked
// for; decode resolves them against the hoisted state.
vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    getBlock: (_sealed: boolean) => ({ kind: "block" }),
    getEventsAtBlockHeightRange: (type: string, s: number, e: number) => ({ kind: "events", type, s, e }),
    send: async (args: unknown[]) => args[0],
    decode: async (descriptor: { kind: string; type?: string }) => {
      if (descriptor.kind === "block") {
        if (state.sealedThrows) throw new Error("access node unavailable")
        return { height: state.sealedHeight }
      }
      return state.eventsByType[descriptor.type ?? ""] ?? []
    },
  },
}))

process.env.INGEST_SECRET_TOKEN = "ts-indexer-token"

const { POST } = await import("@/app/api/sales-indexer/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const MARKET_EVENT = "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased"
const DAPPER_MERCHANT = "0xc1e4f4f4c4257510"

function storefrontSale(nftId: string, price: string, txId: string, commissionReceiver: string | null) {
  return {
    blockHeight: 1100,
    blockTimestamp: "2026-07-17T12:00:00Z",
    transactionId: txId,
    data: {
      purchased: true,
      nftType: { typeID: "A.0b2a3299cc857e29.TopShot.NFT" },
      nftID: nftId,
      salePrice: price,
      commissionReceiver,
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/sales-indexer", {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ts-indexer-token" }),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

function pipelineRun(spy: ReturnType<typeof install>) {
  return (spy.writes.pipeline_runs ?? [])
    .flatMap((w) => w.rows)
    .filter((r) => r.pipeline === "topshot-sales-indexer")
    .at(-1)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ts-indexer-token"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  state.afterCbs.length = 0
  state.chained.length = 0
  state.sealedHeight = 1250
  state.sealedThrows = false
  state.eventsByType = {}
  state.decodeByTx = {}
  fetchMock = installFetchMock([jsonRoute("ts-proxy.test", { data: null })])
})

describe("sales-indexer — resolution ladder", () => {
  it("ingests a StorefrontV2 sale via the wmc path with tx-decoded buyer/exec accounts", async () => {
    const tx1 = "1".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [storefrontSale("9001", "15.5", tx1, DAPPER_MERCHANT)]
    state.decodeByTx[tx1] = {
      buyer: "0xaaaaaaaaaaaaaaaa",
      payer: "0x18eb4ee6b3c026d2",
      proposer: "0xead892083b3e2c6c",
    }
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: {
        data: [{ moment_id: "9001", edition_key: "3:45", serial_number: 12 }],
        error: null,
      },
      editions: { data: [{ id: "uuid-345", external_id: "3:45" }], error: null },
      sales: { data: null, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-345",
      collection_id: TOPSHOT,
      collection: "nba_top_shot",
      nft_id: "9001",
      price_usd: 15.5,
      serial_number: 12,
      marketplace: "topshot", // Dapper-merchant commission -> topshot venue
      source: "onchain",
      buyer_address: "0xaaaaaaaaaaaaaaaa",
      payer_address: "0x18eb4ee6b3c026d2",
      proposer_address: "0xead892083b3e2c6c",
      transaction_hash: tx1,
    })

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })

    const run = pipelineRun(spy)
    expect(run).toMatchObject({ ok: true, rows_found: 1, rows_written: 1, cursor_after: "1250" })
    expect((run?.extra as Record<string, unknown>).buyers_resolved).toBe(1)
    expect(state.chained).toEqual([{ path: "/api/fmv-recalc", chain: false }])
  })

  it("ingests a TopShotMarketV3 sale via the canonical-guarded moments path", async () => {
    const tx2 = "2".repeat(64)
    state.eventsByType[MARKET_EVENT] = [
      {
        blockHeight: 1105,
        blockTimestamp: "2026-07-17T12:05:00Z",
        transactionId: tx2,
        data: { id: "9002", price: "8.25", seller: "0xbbbbbbbbbbbbbbbb" },
      },
    ]
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      moments: { data: [{ nft_id: "9002", edition_id: "uuid-77", serial_number: 3 }], error: null },
      editions: { data: [{ id: "uuid-77", external_id: "10:20" }], error: null },
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "uuid-77",
      nft_id: "9002",
      price_usd: 8.25,
      serial_number: 3,
      marketplace: "topshot",
      seller_address: "0xbbbbbbbbbbbbbbbb",
    })
  })

  it("UUID-dupe guard: a moments row keyed to a non-canonical edition is DROPPED, not trusted", async () => {
    const tx3 = "3".repeat(64)
    state.eventsByType[MARKET_EVENT] = [
      {
        blockHeight: 1106,
        blockTimestamp: "2026-07-17T12:06:00Z",
        transactionId: tx3,
        data: { id: "9003", price: "5.00", seller: null },
      },
    ]
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      // The moments table knows the nft — but its edition is a UUID-pair dupe.
      moments: { data: [{ nft_id: "9003", edition_id: "uuid-dupe", serial_number: 9 }], error: null },
      editions: [
        // 4b canonical check: the edition's external_id is a UUID pair -> NOT canonical.
        { data: [{ id: "uuid-dupe", external_id: "abc-123:def-456" }], error: null },
        // 4d GQL maybeSingle: no canonical edition row exists yet.
        { data: null, error: null },
        // 4e reverse-resolve of the stub id.
        { data: [{ id: "stub-uuid", external_id: "12:34" }], error: null },
      ],
      "rpc:ensure_topshot_edition_stub": { data: "stub-uuid", error: null },
      sales: { data: null, error: null },
    })
    // The GQL fallback resolves the on-chain int pair.
    fetchMock?.restore()
    fetchMock = installFetchMock([
      jsonRoute("ts-proxy.test", {
        data: {
          getMintedMoment: {
            data: { flowSerialNumber: "7", play: { flowID: "34" }, set: { flowId: 12 } },
          },
        },
      }),
    ])

    await POST(req())
    await runDeferred()

    // The sale landed on the GQL-resolved canonical stub — NOT uuid-dupe.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({ edition_id: "stub-uuid", nft_id: "9003", serial_number: 7 })
    // The self-heal stub RPC was invoked with the on-chain int pair.
    const stubCall = spy.rpcCalls.find((c) => c.name === "ensure_topshot_edition_stub")
    expect(stubCall?.args).toMatchObject({ p_set_id_onchain: 12, p_play_id_onchain: 34 })
    const run = pipelineRun(spy)
    expect((run?.extra as Record<string, unknown>).gql_resolved).toBe(1)
  })

  it("F9 parallel split: a confirmed parallel is redirected from the base onto its ::subID edition", async () => {
    const tx4 = "4".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [storefrontSale("9004", "60", tx4, DAPPER_MERCHANT)]
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      // On-chain submap confirms nft 9004 as parallel 18 of base 257:8664.
      topshot_moment_subeditions: {
        data: [{ nft_id: "9004", subedition_id: 18, base_external_id: "257:8664" }],
        error: null,
      },
      wallet_moments_cache: {
        data: [{ moment_id: "9004", edition_key: "257:8664", serial_number: 5 }],
        error: null,
      },
      editions: [
        // subExtToId: the ::18 parallel edition exists.
        { data: [{ id: "uuid-par", external_id: "257:8664::18" }], error: null },
        // 4c: the wmc edition_key resolves to the BASE edition.
        { data: [{ id: "uuid-base", external_id: "257:8664" }], error: null },
        // 4e reverse-resolve.
        { data: [{ id: "uuid-base", external_id: "257:8664" }], error: null },
      ],
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    // The sale landed on the parallel edition, not the base Standard printing.
    expect(saleRows[0]).toMatchObject({ edition_id: "uuid-par", serial_number: 5 })
    const run = pipelineRun(spy)
    expect((run?.extra as Record<string, unknown>).parallel_splits).toBe(1)
  })

  it("no events: advances the cursor, logs no_events, and still chains fmv-recalc", async () => {
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    const cursorUpdate = spy.writes.event_cursor?.find((w) => w.method === "update")
    expect(cursorUpdate?.rows[0]).toMatchObject({ last_processed_block: 1250 })
    const run = pipelineRun(spy)
    expect(run).toMatchObject({ ok: true, rows_found: 0 })
    expect((run?.extra as Record<string, unknown>).reason).toBe("no_events")
    expect(state.chained).toEqual([{ path: "/api/fmv-recalc", chain: false }])
  })

  it("a fatal error (sealed-height fetch down) writes an ok=false pipeline_runs row", async () => {
    state.sealedThrows = true
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
    })

    await POST(req())
    await runDeferred()

    const run = pipelineRun(spy)
    expect(run).toMatchObject({ ok: false })
    expect(String(run?.error)).toContain("access node unavailable")
    expect((run?.extra as Record<string, unknown>).fatal).toBe(true)
  })

  it("401s without the token", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/sales-indexer", { method: "POST" }))
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })
})
