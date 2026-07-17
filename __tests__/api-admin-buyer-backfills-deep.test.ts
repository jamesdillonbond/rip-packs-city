import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { adminReq } from "./helpers/admin-req"

// Deep-loop tests for the two after()-deferred buyer-recovery cursor walkers:
//
//   /api/admin/backfill-topshot-buyers   (Bearer INGEST_SECRET_TOKEN only;
//     forward lane 2025+ via decodeTopShotSaleTx, inert historical spork lane)
//   /api/admin/backfill-allday-buyers    (INGEST or CRON bearer, or ?token=;
//     ?collection=allday|golazos; deposit-primary + tx-authorizers fallback)
//
// The shallow suites stop at the 202-style ack; these capture the after()
// callback and drive the deferred body, asserting the real contracts: the
// buyer-IS-NULL-gated sales patch, the sold_at cursor stored in
// pipeline_runs.extra, the wrap-to-null on a short batch, and the finally-block
// pipeline_runs row that makes every exit path visible (the invisible-failure
// class the file comments document).

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  tsDecodeCalls: [] as Array<{ tx: string; nftId: string }>,
  sporkCalls: [] as Array<{ tx: string; nftId: string; url: string; secret: string }>,
  v1Calls: [] as Array<{ tx: string; config: Record<string, unknown> }>,
  decodeResults: {} as Record<string, Record<string, unknown>>,
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

const EMPTY_TS_DECODE = { buyer: null, seller: null, payer: null, proposer: null, ok: false }
const EMPTY_V1_DECODE = {
  buyer: null,
  seller: null,
  priceDuc: null,
  priceCertain: false,
  priceReason: "tx_fetch_failed",
  sampleAmounts: [],
}

vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({
  decodeTopShotSaleTx: async (tx: string, nftId: string) => {
    state.tsDecodeCalls.push({ tx, nftId })
    return state.decodeResults[tx] ?? EMPTY_TS_DECODE
  },
  decodeTopShotSaleTxViaSpork: async (tx: string, nftId: string, url: string, secret: string) => {
    state.sporkCalls.push({ tx, nftId, url, secret })
    return state.decodeResults[tx] ?? EMPTY_TS_DECODE
  },
  decodeV1SaleTx: async (tx: string, config: Record<string, unknown>) => {
    state.v1Calls.push({ tx, config })
    return state.decodeResults[tx] ?? EMPTY_V1_DECODE
  },
}))

// Both routes capture INGEST_SECRET_TOKEN (and allday also CRON_SECRET) at
// MODULE LOAD, so the env must be set before the imports below.
process.env.INGEST_SECRET_TOKEN = "ingest-secret"
process.env.CRON_SECRET = "cron-secret"

const tsRoute = await import("@/app/api/admin/backfill-topshot-buyers/route")
const alldayRoute = await import("@/app/api/admin/backfill-allday-buyers/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.CRON_SECRET = "cron-secret"
  delete process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED
  delete process.env.SPORK_PROXY_URL
  delete process.env.SPORK_PROXY_SECRET
  state.afterCbs.length = 0
  state.tsDecodeCalls.length = 0
  state.sporkCalls.length = 0
  state.v1Calls.length = 0
  state.decodeResults = {}
  install({})
})

afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
  vi.useRealTimers()
})

describe("POST /api/admin/backfill-topshot-buyers (forward lane)", () => {
  it("401s without / with a wrong bearer, and accepts ?token=", async () => {
    expect((await tsRoute.POST(adminReq("https://t/api/admin/backfill-topshot-buyers"))).status).toBe(401)
    expect(
      (
        await tsRoute.POST(
          adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer nope" }),
        )
      ).status,
    ).toBe(401)
    // CRON_SECRET is NOT accepted here — this route is INGEST-token-only.
    expect(
      (
        await tsRoute.POST(
          adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer cron-secret" }),
        )
      ).status,
    ).toBe(401)
    const ok = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers?token=ingest-secret"),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, queued: true })
  })

  it("resumes below the stored cursor, patches only decodable rows, wraps the cursor on a short batch, and logs the run", async () => {
    const spy = install({
      pipeline_runs: { data: { extra: { cursor_sold_at: "2026-07-01T00:00:00Z" } }, error: null },
      sales: [
        {
          data: [
            { id: "sA", nft_id: "111", transaction_hash: "txa", sold_at: "2026-06-30T12:00:00Z", seller_address: null },
            { id: "sB", nft_id: "222", transaction_hash: "txb", sold_at: "2026-06-29T12:00:00Z", seller_address: null },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
    })
    state.decodeResults["txa"] = {
      buyer: "0xb001", seller: "0xs001", payer: "0xp001", proposer: "0xpr01", ok: true,
    }
    // txb decodes to nothing → decode_failed, stays null for the next pass.

    const res = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer ingest-secret" }),
    )
    expect(res.status).toBe(200)
    await runDeferred()

    // Both rows attempted, with the sale's own nft_id passed to the decoder.
    expect(state.tsDecodeCalls).toEqual([
      { tx: "txa", nftId: "111" },
      { tx: "txb", nftId: "222" },
    ])

    // Exactly one sales patch, carrying buyer + execution accounts + the
    // seller fill (row had seller_address null).
    const updates = (spy.writes.sales ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0].rows[0]).toEqual({
      buyer_address: "0xb001",
      payer_address: "0xp001",
      proposer_address: "0xpr01",
      seller_address: "0xs001",
    })

    // The finally-block observability row: found 2, wrote 1, skipped 1, and the
    // cursor WRAPPED to null (2 < BATCH → bottom reached → fresh top-down pass).
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({
      pipeline: "topshot-buyer-backfill",
      collection_slug: "nba-top-shot",
      rows_found: 2,
      rows_written: 1,
      rows_skipped: 1,
      ok: true,
      error: null,
    })
    expect(runRow.extra).toMatchObject({
      cursor_sold_at: null,
      cursor_before: "2026-07-01T00:00:00Z",
      buyers_resolved: 1,
      exec_accounts_resolved: 1,
      sellers_filled: 1,
      decode_failed: 1,
      wrapped: true,
      bailed_early: false,
    })
  })

  it("does not clobber an existing seller_address", async () => {
    const spy = install({
      pipeline_runs: { data: null, error: null },
      sales: [
        {
          data: [
            { id: "sC", nft_id: "333", transaction_hash: "txc", sold_at: "2026-06-28T00:00:00Z", seller_address: "0xkeepme" },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
    })
    state.decodeResults["txc"] = { buyer: "0xb002", seller: "0xother", payer: null, proposer: null, ok: true }

    await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer ingest-secret" }),
    )
    await runDeferred()

    const updates = (spy.writes.sales ?? []).filter((w) => w.method === "update")
    expect(updates[0].rows[0]).toEqual({ buyer_address: "0xb002" })
  })

  it("advances the cursor to the oldest processed sold_at on a FULL batch (no wrap)", async () => {
    vi.useFakeTimers()
    // Exactly BATCH=100 rows, sold_at strictly descending; all decode empty so
    // the loop is pure cursor bookkeeping (100 × 40ms inter-row delays, faked).
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`,
      nft_id: String(i),
      transaction_hash: `tx${i}`,
      sold_at: new Date(Date.UTC(2026, 5, 30) - i * 60_000).toISOString(),
      seller_address: null,
    }))
    const oldest = rows[99].sold_at
    const spy = install({
      pipeline_runs: { data: null, error: null },
      sales: [{ data: rows, error: null }, { data: null, error: null }],
    })

    const res = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer ingest-secret" }),
    )
    expect(res.status).toBe(200)
    const deferred = runDeferred()
    await vi.runAllTimersAsync()
    await deferred

    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ rows_found: 100, rows_written: 0, rows_skipped: 100, ok: true })
    expect(runRow.extra).toMatchObject({ cursor_sold_at: oldest, wrapped: false })
  })

  it("still writes an ok=false pipeline_runs row when the select fails (nothing is invisible)", async () => {
    const spy = install({
      pipeline_runs: { data: null, error: null },
      sales: { data: null, error: { message: "select boom" } },
    })

    await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers", { authorization: "Bearer ingest-secret" }),
    )
    await runDeferred()

    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ ok: false, error: "select boom", rows_found: 0, rows_written: 0 })
  })
})

describe("POST /api/admin/backfill-topshot-buyers?mode=historical (spork lane)", () => {
  it("ships inert: skipped when disabled, and when enabled but unconfigured", async () => {
    const r1 = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers?mode=historical", { authorization: "Bearer ingest-secret" }),
    )
    expect(await r1.json()).toMatchObject({ ok: true, queued: false, mode: "historical", skipped: "historical_disabled" })

    process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED = "1"
    const r2 = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers?mode=historical", { authorization: "Bearer ingest-secret" }),
    )
    expect(await r2.json()).toMatchObject({ queued: false, skipped: "spork_proxy_unconfigured" })
    expect(state.afterCbs).toHaveLength(0) // nothing deferred in either case
  })

  it("routes decodes through the spork proxy and logs its OWN pipeline (topshot-buyer-backfill-historical)", async () => {
    process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED = "1"
    process.env.SPORK_PROXY_URL = "https://spork-proxy.test/"
    process.env.SPORK_PROXY_SECRET = "spork-secret"
    const spy = install({
      pipeline_runs: { data: null, error: null },
      sales: [
        {
          data: [
            { id: "h1", nft_id: "999", transaction_hash: "txh", sold_at: "2023-03-01T00:00:00Z", seller_address: null },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
    })
    state.decodeResults["txh"] = { buyer: "0xhist", seller: null, payer: null, proposer: null, ok: true }

    const res = await tsRoute.POST(
      adminReq("https://t/api/admin/backfill-topshot-buyers?mode=historical", { authorization: "Bearer ingest-secret" }),
    )
    expect(await res.json()).toMatchObject({ ok: true, queued: true, mode: "historical" })
    await runDeferred()

    expect(state.sporkCalls).toEqual([
      { tx: "txh", nftId: "999", url: "https://spork-proxy.test/", secret: "spork-secret" },
    ])
    expect(state.tsDecodeCalls).toHaveLength(0) // forward decoder untouched
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ pipeline: "topshot-buyer-backfill-historical", rows_written: 1, ok: true })
    expect(runRow.extra).toMatchObject({ lane: "historical", buyers_resolved: 1, wrapped: true })
  })
})

describe("/api/admin/backfill-allday-buyers", () => {
  function alldayReq(url: string, auth?: string) {
    return adminReq(url, auth ? { authorization: auth } : {})
  }

  it("accepts CRON_SECRET on GET (Vercel cron) and 400s an unknown collection", async () => {
    const ok = await alldayRoute.GET(
      alldayReq("https://t/api/admin/backfill-allday-buyers", "Bearer cron-secret"),
    )
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, queued: true, collection: "allday" })
    state.afterCbs.length = 0

    const bad = await alldayRoute.POST(
      alldayReq("https://t/api/admin/backfill-allday-buyers?collection=ufc", "Bearer ingest-secret"),
    )
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain("allday, golazos")
    expect(state.afterCbs).toHaveLength(0)

    expect((await alldayRoute.POST(alldayReq("https://t/api/admin/backfill-allday-buyers"))).status).toBe(401)
  })

  it("resolves via Deposit.to, falls back to unambiguous tx authorizers, and audits every buyer write", async () => {
    const spy = install({
      pipeline_runs: { data: { extra: { cursor_sold_at: "2026-07-10T00:00:00Z" } }, error: null },
      sales: [
        {
          data: [
            // A: clean deposit decode; escrow seller is filtered, so no seller fill.
            { id: "a1", nft_id: "10", transaction_hash: "txa", sold_at: "2026-07-09T00:00:00Z", buyer_address: null, seller_address: null },
            // B: deposit decode lands on the Flowty escrow → authorizers fallback.
            { id: "a2", nft_id: "20", transaction_hash: "txb", sold_at: "2026-07-08T00:00:00Z", buyer_address: "0x3cdbb3d569211ff3", seller_address: "0xseller2" },
            // C: nothing decodable + ambiguous authorizers → decode_failed.
            { id: "a3", nft_id: "30", transaction_hash: "txc", sold_at: "2026-07-07T00:00:00Z", buyer_address: null, seller_address: null },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      audit_20260706_allday_buyer_backfill: { data: null, error: null },
    })
    state.decodeResults["txa"] = { ...EMPTY_V1_DECODE, buyer: "0xB0B0000000000001", seller: "0x18eb4ee6b3c026d2" }
    state.decodeResults["txb"] = { ...EMPTY_V1_DECODE, buyer: "0x3cdbb3d569211ff3", seller: null }
    // txc → EMPTY_V1_DECODE

    const txbStub: FetchStub = {
      match: (url) => url.includes("/v1/transactions/txb"),
      respond: () => ({
        json: {
          proposal_key: { address: "ead892083b3e2c6c" }, // excluded (Dapper co-signer)
          authorizers: ["abc123def4567890"],
          payer: "18eb4ee6b3c026d2", // excluded (escrow)
        },
      }),
    }
    const txcStub: FetchStub = {
      match: (url) => url.includes("/v1/transactions/txc"),
      respond: () => ({
        json: { proposal_key: { address: "1111111111111111" }, authorizers: ["2222222222222222"], payer: null },
      }),
    }
    fetchMock = installFetchMock([txbStub, txcStub])

    const res = await alldayRoute.POST(
      alldayReq("https://t/api/admin/backfill-allday-buyers", "Bearer ingest-secret"),
    )
    expect(res.status).toBe(200)
    await runDeferred()

    // Decode configured with the AllDay contract events.
    expect(state.v1Calls[0].config).toMatchObject({
      depositEventType: "A.e4cf4bdc1751c65d.AllDay.Deposit",
      withdrawEventType: "A.e4cf4bdc1751c65d.AllDay.Withdraw",
      nftId: "10",
    })

    const updates = (spy.writes.sales ?? []).filter((w) => w.method === "update")
    expect(updates).toHaveLength(2)
    // A: buyer normalized to lowercase; escrow "seller" was NOT written.
    expect(updates[0].rows[0]).toEqual({ buyer_address: "0xb0b0000000000001" })
    // B: authorizers fallback resolved the single non-intermediary candidate.
    expect(updates[1].rows[0]).toEqual({ buyer_address: "0xabc123def4567890" })

    // Reversibility contract: every buyer write is captured with its before-state.
    const audit = (spy.writes.audit_20260706_allday_buyer_backfill ?? []).find((w) => w.method === "upsert")!
    expect(audit.rows).toEqual([
      expect.objectContaining({
        sale_id: "a1", old_buyer_address: null, new_buyer_address: "0xb0b0000000000001", method: "deposit_to",
      }),
      expect.objectContaining({
        sale_id: "a2", old_buyer_address: "0x3cdbb3d569211ff3", new_buyer_address: "0xabc123def4567890", method: "tx_authorizers",
      }),
    ])

    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({
      pipeline: "allday-buyer-backfill",
      collection_slug: "nfl-all-day",
      rows_found: 3,
      rows_written: 2,
      rows_skipped: 1,
      ok: true,
    })
    expect(runRow.extra).toMatchObject({
      via_deposit_to: 1,
      via_tx_authorizers: 1,
      decode_failed: 1,
      sellers_filled: 0,
      cursor_before: "2026-07-10T00:00:00Z",
      cursor_sold_at: null, // 3 < BATCH → wrapped
      wrapped: true,
    })
  })

  it("?collection=golazos swaps the contract config and pipeline identity", async () => {
    const spy = install({
      pipeline_runs: { data: null, error: null },
      sales: [
        {
          data: [
            { id: "g1", nft_id: "77", transaction_hash: "txg", sold_at: "2026-07-01T00:00:00Z", buyer_address: null, seller_address: null },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      audit_20260706_allday_buyer_backfill: { data: null, error: null },
    })
    state.decodeResults["txg"] = { ...EMPTY_V1_DECODE, buyer: "0xg0000000000001aa", seller: "0xg0000000000002bb" }

    await alldayRoute.POST(
      alldayReq("https://t/api/admin/backfill-allday-buyers?collection=golazos", "Bearer ingest-secret"),
    )
    await runDeferred()

    expect(state.v1Calls[0].config).toMatchObject({
      depositEventType: "A.87ca73a41bb50ad5.Golazos.Deposit",
      withdrawEventType: "A.87ca73a41bb50ad5.Golazos.Withdraw",
    })
    const updates = (spy.writes.sales ?? []).filter((w) => w.method === "update")
    expect(updates[0].rows[0]).toEqual({
      buyer_address: "0xg0000000000001aa",
      seller_address: "0xg0000000000002bb",
    })
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ pipeline: "golazos-buyer-backfill", collection_slug: "laliga-golazos" })
    expect(runRow.extra).toMatchObject({ sellers_filled: 1, buyers_resolved: 1 })
  })
})
