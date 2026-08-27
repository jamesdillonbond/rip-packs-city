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
  // Chunk start-heights whose event fetch should THROW, so the route's
  // per-chunk catch runs and `firstFailedChunkStart` is set. Needed to drive
  // the cursor-hold branch, which is otherwise unreachable from a test.
  throwEventsAtStart: [] as number[],
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
      const d = descriptor as { kind: string; type?: string; s?: number }
      if (typeof d.s === "number" && state.throwEventsAtStart.includes(d.s)) {
        throw new Error(`access node chunk ${d.s} unavailable`)
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

// First BATCH insert to `table` rejects with `batchCode` (a 23505 dupe by
// default); each per-row RETRY is then adjudicated by `isDupeRow` so the
// offending row resolves with a 23505 while every other row lands. Lets a test
// prove the all-or-nothing insert contract: a batch mixing one dupe with new
// rows must drop only the dupe and still write the rest.
function withDupeAwareInsert(
  spy: ReturnType<typeof makeInstrumentedSupabaseFixture>,
  table: string,
  isDupeRow: (row: Record<string, unknown>) => boolean,
  batchCode = "23505",
) {
  const fixture = spy.fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = fixture.from.bind(fixture)
  let firstBatchSeen = false
  fixture.from = (t: string) => {
    const b = baseFrom(t)
    if (t === table) {
      const base = b.insert as (rows: unknown) => unknown
      b.insert = (rows: unknown) => {
        base(rows) // record the attempt in spy.writes
        if (Array.isArray(rows)) {
          if (!firstBatchSeen) {
            firstBatchSeen = true
            return Promise.resolve({ data: null, error: { code: batchCode, message: "duplicate key" } })
          }
          return Promise.resolve({ data: null, error: null })
        }
        if (isDupeRow(rows as Record<string, unknown>)) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } })
        }
        return Promise.resolve({ data: null, error: null })
      }
    }
    return b
  }
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
  state.throwEventsAtStart = []
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

  it("tags the marketplace venue from the commissionReceiver: flowty and 'other' (not just topshot)", async () => {
    // determineMarketplace: null/Dapper -> topshot (the StorefrontV2 test above),
    // a receiver containing 'flowty' -> flowty, anything else -> other. Both the
    // flowty and other arms were dark, so a mislabel here (every StorefrontV2 sale
    // getting stamped 'topshot') would go unnoticed — and venue is what the sales
    // analytics split on. Drive one of each through the wmc path in one batch.
    const txFlowty = "3".repeat(64)
    const txOther = "4".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [
      storefrontSale("9101", "10.0", txFlowty, "flowty-fee-router"),
      storefrontSale("9102", "11.0", txOther, "0x9999999999999999"),
    ]
    state.decodeByTx[txFlowty] = { buyer: "0xa1a1a1a1a1a1a1a1" }
    state.decodeByTx[txOther] = { buyer: "0xb2b2b2b2b2b2b2b2" }
    const spy = install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: {
        data: [
          { moment_id: "9101", edition_key: "3:45", serial_number: 5 },
          { moment_id: "9102", edition_key: "3:45", serial_number: 6 },
        ],
        error: null,
      },
      editions: { data: [{ id: "uuid-345", external_id: "3:45" }], error: null },
      sales: { data: null, error: null },
    })

    await POST(req())
    await runDeferred()

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    const byNft = Object.fromEntries(saleRows.map((r) => [r.nft_id, r]))
    expect(byNft["9101"].marketplace).toBe("flowty")
    expect(byNft["9102"].marketplace).toBe("other")
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

  it("the Top Shot GQL proxy call is time-bounded", async () => {
    // 🚨 WHY. `fetch()` has NO default timeout, and this call runs up to GQL_MAX
    // (50) times inside an `after()` body under maxDuration 120 — so ONE upstream
    // holding the connection open consumes the whole tick, and a maxDuration kill
    // takes the terminal pipeline_runs row with it (this route's own header says
    // so). The failure would then be invisible on a HIGH-severity watchlist
    // pipeline. Same class that cost the candy board a 44h blackout (2026-08-27);
    // the sibling decode path was already bounded at 8s, this call was not.
    //
    // ⚠ Asserted on the REQUEST INIT, not the source text — a source grep would
    // be satisfied by the comment you are reading.
    const txG = "a".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [storefrontSale("9003", "60", txG, DAPPER_MERCHANT)]
    install({
      editions: [
        { data: [], error: null },
        { data: [{ id: "stub-uuid", external_id: "12:34" }], error: null },
      ],
      "rpc:ensure_topshot_edition_stub": { data: "stub-uuid", error: null },
      sales: { data: null, error: null },
    })
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

    const gqlCalls = fetchMock.calls.filter((c) => /ts-proxy\.test/.test(c.url))
    // Not vacuous: if the GQL fallback never fired, the loop below asserts nothing.
    expect(gqlCalls.length).toBeGreaterThan(0)
    const unbounded = gqlCalls.filter((c) => !c.init?.signal).map((c) => c.url)
    expect(
      unbounded,
      "every Top Shot GQL proxy request must carry an AbortSignal — an unbounded " +
        "one consumes the whole 120s tick and the run dies without a terminal row",
    ).toEqual([])
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

describe("sales-indexer — 23505 all-or-nothing insert contract", () => {
  // A batch insert is all-or-nothing: a single 23505 fails the whole statement
  // and writes NONE of the batch, so swallowing it would discard every
  // co-batched NEW sale permanently (the block cursor advances past them
  // regardless). Drive a batch that MIXES one already-seen dupe (nft 9001) with
  // a genuinely new sale (nft 9005): insertIndividually must fail only the dupe
  // and still write the new row.
  it("drops ONLY the dupe on the sales batch — the co-batched NEW sale still lands", async () => {
    const txDupe = "1".repeat(64)
    const txNew = "5".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [
      storefrontSale("9001", "15.5", txDupe, DAPPER_MERCHANT),
      storefrontSale("9005", "9.25", txNew, DAPPER_MERCHANT),
    ]
    state.decodeByTx[txDupe] = { buyer: "0xaaaaaaaaaaaaaaaa" }
    state.decodeByTx[txNew] = { buyer: "0xbbbbbbbbbbbbbbbb" }
    const spy = withDupeAwareInsert(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        topshot_moment_subeditions: { data: [], error: null },
        wallet_moments_cache: {
          data: [
            { moment_id: "9001", edition_key: "3:45", serial_number: 12 },
            { moment_id: "9005", edition_key: "3:45", serial_number: 13 },
          ],
          error: null,
        },
        editions: { data: [{ id: "uuid-345", external_id: "3:45" }], error: null },
        sales: { data: null, error: null },
      }),
      "sales",
      (row) => row.nft_id === "9001", // the dupe
    )

    const res = await POST(req())
    expect(res.status).toBe(202)
    await runDeferred()

    const inserts = spy.writes.sales ?? []
    const batch = inserts.find((w) => Array.isArray(w.rows) && w.rows.length === 2)
    expect(batch).toBeTruthy()
    const perRow = inserts.filter((w) => w.rows.length === 1).flatMap((w) => w.rows)
    expect(perRow.map((r) => r.nft_id).sort()).toEqual(["9001", "9005"])
    // rows_written = the survivor only (NOT 0 — the pre-fix all-or-nothing loss);
    // the dupe is counted under duped -> rows_skipped.
    const run = pipelineRun(spy)
    expect(run).toMatchObject({ ok: true, rows_written: 1 })
    expect((run?.extra as Record<string, unknown>).duped).toBe(1)
  })

  it("retries row-by-row on a NON-dupe batch error too — both sales land", async () => {
    // A transient batch error (08006) is not a dupe; every row is new, so the
    // fallback must land ALL of them rather than swallow the batch.
    const tx1 = "6".repeat(64)
    const tx2 = "7".repeat(64)
    state.eventsByType[STOREFRONT_EVENT] = [
      storefrontSale("9006", "3.00", tx1, DAPPER_MERCHANT),
      storefrontSale("9007", "4.00", tx2, DAPPER_MERCHANT),
    ]
    const spy = withDupeAwareInsert(
      install({
        event_cursor: { data: { last_processed_block: 1000 }, error: null },
        topshot_moment_subeditions: { data: [], error: null },
        wallet_moments_cache: {
          data: [
            { moment_id: "9006", edition_key: "3:45", serial_number: 1 },
            { moment_id: "9007", edition_key: "3:45", serial_number: 2 },
          ],
          error: null,
        },
        editions: { data: [{ id: "uuid-345", external_id: "3:45" }], error: null },
        sales: { data: null, error: null },
      }),
      "sales",
      () => false, // nothing is a dupe on retry -> both land
      "08006",
    )

    await POST(req())
    await runDeferred()

    const run = pipelineRun(spy)
    expect(run).toMatchObject({ ok: true, rows_written: 2 })
    expect((run?.extra as Record<string, unknown>).duped).toBe(0)
  })
})

// ── THE PARTIAL-SCAN CURSOR HOLD ────────────────────────────────────────────
//
// ⚠ THE HIGHEST-STAKES BRANCH IN THIS ROUTE, AND UNTIL NOW IT WAS HELD BY A
// GREP. `__tests__/indexer-cursor-hold-on-partial-scan-guard.test.ts` asserts
// the SOURCE contains `firstFailedChunkStart - 1` and `partial_scan: true`.
// That is a tripwire on the spelling; it cannot see whether the branch is ever
// REACHED, nor what value actually reaches `event_cursor`. The sibling route
// `allday-listings-indexer` already has behavioural cases for its own copy of
// this logic (api-allday-listings-indexer-deep). `sales-indexer` did not.
//
// WHAT GOES WRONG IF IT BREAKS. The scan walks blocks in 250-height chunks. If
// one chunk's event fetch throws and the cursor still advances to
// `targetHeight`, every block in and after the failed chunk is marked processed
// without ever being read — the sales in them are lost PERMANENTLY, because
// nothing ever revisits a block below the cursor. There is no error, no
// ok:false, and no row count that looks wrong; the pipeline reports a clean run
// over a range it never scanned. That is the absence-not-an-error shape, on the
// table the whole product prices from.
//
// Measured before writing these: branch coverage of this route was 59.3%, the
// worst of any reachable route in `app/api`, and lines 303-320 (the cap and the
// partial-scan extra) had no covered arm at all.
describe("sales-indexer — a failed chunk must HOLD the cursor, not skip its blocks", () => {
  // lastBlock 1000, sealed 1750 -> targetHeight 1750, so the scan is three
  // chunks: 1001-1250, 1251-1500, 1501-1750. Three is the minimum that can tell
  // "first failed chunk" apart from "last failed chunk".
  function threeChunkScan() {
    state.sealedHeight = 1750
    return install({
      event_cursor: { data: { last_processed_block: 1000 }, error: null },
      topshot_moment_subeditions: { data: [], error: null },
      wallet_moments_cache: { data: [], error: null },
      editions: { data: [], error: null },
      sales: { data: null, error: null },
    })
  }

  const cursorWrites = (spy: ReturnType<typeof install>) =>
    (spy.writes.event_cursor ?? []).flatMap((w) => w.rows)

  // ⚠ This route writes `pipeline_runs` DIRECTLY, not through log_pipeline_run —
  // `writePipelineRun` inserts the row so Postgres can compute the GENERATED
  // duration_ms (passing it explicitly returns 428C9, which an earlier version
  // swallowed and lost the whole row). So the field names are the COLUMN names,
  // and `cursor_after` is stringified.
  // ⚠ Select the TERMINAL row by pipeline name, never by index. Since the
  // invocation heartbeat landed, `pipeline_runs` receives a
  // `topshot-sales-indexer-heartbeat` marker FIRST, so `[0]` is the marker and
  // every assertion below would silently start measuring the wrong row — the
  // marker has no `extra.partial_scan`, so the cursor-hold cases would fail for
  // a reason that has nothing to do with the cursor.
  const runRow = (spy: ReturnType<typeof install>) =>
    (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => (r as Record<string, unknown>).pipeline === "topshot-sales-indexer") as Record<
      string,
      unknown
    >
  const runExtra = (spy: ReturnType<typeof install>) =>
    (runRow(spy).extra ?? {}) as Record<string, unknown>

  it("a clean three-chunk scan advances the cursor all the way to the target", async () => {
    // ⚠ THE CONTROL. Without it, every assertion below passes on a route that
    // simply never advances the cursor at all — the fixture could not tell a
    // working hold from a broken advance.
    const spy = threeChunkScan()

    expect((await POST(req())).status).toBe(202)
    await runDeferred()

    expect(cursorWrites(spy)).toHaveLength(1)
    expect(cursorWrites(spy)[0].last_processed_block).toBe(1750)

    expect(runExtra(spy).partial_scan).toBeUndefined()
    // The marker is a SEPARATE row under a separate name — asserted here so the
    // terminal-row selection above cannot quietly become an index again.
    const names = (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows).map((r) => (r as Record<string, unknown>).pipeline)
    expect(names).toContain("topshot-sales-indexer-heartbeat")
    expect(names).toContain("topshot-sales-indexer")
  })

  it("a mid-scan chunk failure caps the cursor at the block BEFORE that chunk", async () => {
    state.throwEventsAtStart = [1251] // the second chunk
    const spy = threeChunkScan()

    expect((await POST(req())).status).toBe(202)
    await runDeferred()

    // ⚠ The exact value is the assertion. `partial_scan: true` being present is
    // NOT enough — the flag can be set while the cursor still advances, which is
    // precisely the defect (a run that announces it was partial and then skips
    // the blocks anyway).
    expect(cursorWrites(spy)).toHaveLength(1)
    expect(
      cursorWrites(spy)[0].last_processed_block,
      "blocks 1251-1750 must be re-scanned next tick, so the cursor may not pass 1250",
    ).toBe(1250)
  })

  it("reports the hold in pipeline_runs so an operator can see the range was not covered", async () => {
    state.throwEventsAtStart = [1251]
    const spy = threeChunkScan()

    await POST(req())
    await runDeferred()

    const extra = runExtra(spy)
    expect(extra.partial_scan).toBe(true)
    expect(extra.first_failed_chunk).toBe(1251)
    expect(extra.cursor_held_from).toBe(1750)
    expect(runRow(spy).cursor_after).toBe("1250")
    // ⚠ ok STAYS TRUE. A held cursor is the system working as designed, not a
    // failed run; flipping it to false here would fire the failure-rate alerting
    // on every transient access-node hiccup. The `partial_scan` flag is the
    // signal, and `blocks_scanned` must reflect what was really covered.
    expect(runRow(spy).ok).toBe(true)
    expect(extra.blocks_scanned).toBe(250)
  })

  it("the FIRST failed chunk wins, not the last — two failures still cap at the earlier one", async () => {
    // ⚠ THE CASE THAT MAKES `if (firstFailedChunkStart === null)` OBSERVABLE.
    // With one failing chunk, "first" and "last" are the same block and the
    // guard is unobservable — the documented fixture-cannot-distinguish shape.
    // Failing chunks 2 AND 3 separates them: capping at the LAST failure (1500)
    // would still skip every block in chunk 2.
    state.throwEventsAtStart = [1251, 1501]
    const spy = threeChunkScan()

    await POST(req())
    await runDeferred()

    expect(cursorWrites(spy)[0].last_processed_block).toBe(1250)
    expect(runExtra(spy).first_failed_chunk).toBe(1251)
  })

  it("a failure in the very first chunk holds the cursor exactly where it started", async () => {
    // The boundary: cursorTarget becomes lastBlock, so the run must be a no-op
    // rather than moving the cursor backwards or writing a negative span.
    state.throwEventsAtStart = [1001]
    const spy = threeChunkScan()

    await POST(req())
    await runDeferred()

    expect(cursorWrites(spy)[0].last_processed_block).toBe(1000)
    expect(
      runExtra(spy).blocks_scanned,
      "nothing was scanned, and the run must not claim otherwise",
    ).toBe(0)
  })
})
