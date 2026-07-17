import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/cron/pinnacle-studio-sales-history-backfill — the queue-
// driven studio-platform GQL drain into pinnacle_sales. Pinned contracts:
//   - the exact pinnacle_sales row: id=`${tx}_${nft}` PK, edition_id = the
//     LEGACY set-level key from the queue (never the studio numeric id),
//     render_id = node.render_id (queue render as fallback), sale_price_usd =
//     DUC/1e8, source='pinnacle_studio_history_v1', resolution_status null;
//   - node filters (unpurchased / no-tx / no-price) are dropped BEFORE keying
//     but still counted in `found`;
//   - per-render progress-row accounting (status/attempts/sales_inserted/
//     dupes_skipped/studio_total/gql_pages/error) and the terminal
//     log_pipeline_run rollup incl. pending_remaining;
//   - retryable-vs-frozen classification: GQL failure below MAX_ATTEMPTS stays
//     'pending', the 4th attempt freezes to 'error'; a non-numeric studio
//     edition id errors WITHOUT ever hitting GQL (there is NO
//     editions_maxed_out counter here — DRIFT vs the topshot GQL drain);
//   - dedup honesty: the pre-read against existing ids AND the 23505 row-by-row
//     fallback both count as dupes, never as inserts;
//   - control paths: auth, disabled, seed (RPC count logged as rows_found),
//     queue_empty; dryRun validates &edition= and writes/logs nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "pin-studio-token"
const { POST } = await import("@/app/api/cron/pinnacle-studio-sales-history-backfill/route")

const PROGRESS_TABLE = "pinnacle_studio_sales_history_progress"

interface HistNodeLike {
  nft_id?: string | null
  price?: string | null
  sales_price?: string | null
  purchased?: boolean | null
  receiver_address?: string | null
  created_at?: { block_time: string | null; transaction_hash: string | null } | null
  nft?: { serial_number: string | null; render_id: string | null } | null
}

function histPage(
  nodes: HistNodeLike[],
  opts: { total?: number; endCursor?: string | null; hasNextPage?: boolean } = {},
) {
  return {
    data: {
      searchPinnacleMarketplaceHistory: {
        totalCount: opts.total ?? nodes.length,
        pageInfo: { endCursor: opts.endCursor ?? null, hasNextPage: opts.hasNextPage ?? false },
        edges: nodes.map((node) => ({ node })),
      },
    },
  }
}

function goodNode(over: Partial<HistNodeLike> = {}): HistNodeLike {
  return {
    nft_id: "111",
    price: null,
    sales_price: "250000000", // DUC → $2.50
    purchased: true,
    receiver_address: "0xabcabcabcabcabca",
    created_at: { block_time: "2025-06-01T00:00:00Z", transaction_hash: "0xa" },
    nft: { serial_number: "12", render_id: "r1-node" },
    ...over,
  }
}

/** Studio-GQL stub: serves `pages` in sequence (last repeats); status!==200 throws in-route. */
function studioStub(pages: unknown[], opts: { status?: number } = {}): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("studio-platform.dapperlabs.com"),
    respond: () => {
      const page = pages[Math.min(call, pages.length - 1)]
      call++
      return opts.status ? { status: opts.status, ok: false, text: "upstream" } : { json: page }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = "", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/pinnacle-studio-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer pin-studio-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

function target(over: Partial<{ render_id: string; studio_edition_id: string; legacy_edition_key: string | null; attempts: number }> = {}) {
  return {
    render_id: over.render_id ?? "r1",
    studio_edition_id: over.studio_edition_id ?? "4321",
    legacy_edition_key: over.legacy_edition_key === undefined ? "RC1:Standard:1" : over.legacy_edition_key,
    attempts: over.attempts ?? 0,
  }
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "pin-studio-token"
  delete process.env.PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
})

describe("pinnacle-studio-sales-history-backfill — control paths", () => {
  it("401s without the token; the kill-switch logs an honest ok run", async () => {
    const spy = install({})
    expect((await POST(req("", {}))).status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "disney_pinnacle" })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("seed mode reports the RPC's seeded count as rows_found and never drains", async () => {
    fetchMock = installFetchMock([studioStub([histPage([])])])
    const spy = install({
      "rpc:seed_pinnacle_studio_sales_history_targets": { data: 42, error: null },
    })
    const res = await POST(req("?seed=true"))
    expect(await res.json()).toEqual({ ok: true, mode: "seed", seeded: 42 })
    expect(spy.rpcCalls.some((c) => c.name === "seed_pinnacle_studio_sales_history_targets")).toBe(true)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 42 })
    expect(log?.p_extra).toMatchObject({ mode: "seed", seeded: 42 })
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("self-throttles on saturation; an empty queue logs queue_empty as its own terminal state", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 16 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 16 })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).skipped).toBe("saturation")

    const spy2 = install({
      [PROGRESS_TABLE]: { data: [], error: null },
    })
    const res2 = await POST(req())
    expect(await res2.json()).toMatchObject({ ok: true, note: "queue_empty" })
    expect((terminalLog(spy2.rpcCalls)?.p_extra as Record<string, unknown>).note).toBe("queue_empty")
  })
})

describe("pinnacle-studio-sales-history-backfill — drain loop", () => {
  it("drains one render end-to-end: exact row (legacy key + node render + DUC/1e8), node filters counted in found, progress + log accounting", async () => {
    fetchMock = installFetchMock([
      studioStub([
        histPage(
          [
            goodNode(),
            goodNode({ nft_id: "112", purchased: false }), // filtered
            goodNode({ nft_id: "113", created_at: { block_time: "2025-06-02T00:00:00Z", transaction_hash: null } }), // no tx
            goodNode({ nft_id: "114", sales_price: "0", created_at: { block_time: "2025-06-03T00:00:00Z", transaction_hash: "0xd" } }), // zero price
          ],
          { total: 3 },
        ),
      ]),
    ])
    const spy = install({
      [PROGRESS_TABLE]: [
        { data: [target()], error: null }, // pick
        { data: null, error: null }, // progress update
        { data: null, error: null, count: 7 } as never, // pending_remaining
      ],
      pinnacle_sales: [
        { data: [], error: null }, // existing-id pre-read
        { data: null, error: null }, // insert ok
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    const rows = (spy.writes.pinnacle_sales ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: "0xa_111",
      edition_id: "RC1:Standard:1", // legacy set-level key, NOT the studio numeric id
      render_id: "r1-node", // node.render_id wins over the queue's render
      nft_id: "111",
      sale_price_usd: 2.5, // 250,000,000 DUC / 1e8
      serial_number: 12,
      sold_at: "2025-06-01T00:00:00Z",
      source: "pinnacle_studio_history_v1",
      buyer_address: "0xabcabcabcabcabca",
      seller_address: null,
      resolution_status: null,
    })

    const upd = (spy.writes[PROGRESS_TABLE] ?? []).flatMap((w) => w.rows)
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({
      status: "done",
      attempts: 1,
      sales_inserted: 1,
      dupes_skipped: 0,
      studio_total: 3,
      gql_pages: 1,
      error: null,
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 4, // every node seen, incl. the 3 filtered
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_collection_slug: "disney_pinnacle",
    })
    expect(log?.p_extra).toMatchObject({
      renders_processed: 1,
      renders_drained: 1,
      renders_empty: 0,
      renders_error: 0,
      gql_errors: 0,
      budget_hit: false,
      pending_remaining: 7,
    })
    expect(await res.json()).toMatchObject({
      ok: true,
      renders_processed: 1,
      sales_inserted: 1,
      dupes_skipped: 0,
      renders_drained: 1,
      pending_remaining: 7,
    })
  })

  it("a non-numeric studio edition id errors WITHOUT hitting GQL; GQL failures stay pending below the cap and freeze on attempt 4", async () => {
    fetchMock = installFetchMock([studioStub([], { status: 500 })])
    const spy = install({
      [PROGRESS_TABLE]: [
        {
          data: [
            target({ render_id: "r-bad", studio_edition_id: "not-a-number" }),
            target({ render_id: "r-retry", studio_edition_id: "100", attempts: 0 }),
            target({ render_id: "r-frozen", studio_edition_id: "101", attempts: 3 }),
          ],
          error: null,
        },
        { data: null, error: null }, // r-bad update
        { data: null, error: null }, // r-retry update
        { data: null, error: null }, // r-frozen update
        { data: null, error: null, count: 0 } as never,
      ],
    })

    const res = await POST(req())
    const upd = (spy.writes[PROGRESS_TABLE] ?? []).flatMap((w) => w.rows)
    expect(upd).toHaveLength(3)
    expect(upd[0]).toMatchObject({ status: "error", attempts: 1, error: "non_numeric_edition_id" })
    // Retryable GQL failure below the cap: back to the pending pool.
    expect(upd[1]).toMatchObject({ status: "pending", attempts: 1, error: "GQL 500" })
    // Attempt cap reached: frozen loudly as error.
    expect(upd[2]).toMatchObject({ status: "error", attempts: 4, error: "GQL 500" })

    // The non-numeric target must never have produced a GQL request (2 = the two
    // real targets' single failed page each).
    expect(fetchMock.calls.filter((c) => c.url.includes("studio-platform"))).toHaveLength(2)

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_extra).toMatchObject({
      renders_processed: 3,
      renders_error: 2, // r-bad + r-frozen; r-retry stays pending
      gql_errors: 3,
    })
    expect(await res.json()).toMatchObject({ renders_error: 2, gql_errors: 3, sales_inserted: 0 })
  })

  it("dedup honesty: pre-read hits and the 23505 row-by-row fallback both count as dupes, never inserts", async () => {
    fetchMock = installFetchMock([
      studioStub([
        histPage([
          goodNode({ nft_id: "111", created_at: { block_time: "2025-06-01T00:00:00Z", transaction_hash: "0xa" } }),
          goodNode({ nft_id: "222", created_at: { block_time: "2025-06-02T00:00:00Z", transaction_hash: "0xb" } }),
        ]),
      ]),
    ])
    const spy = install({
      [PROGRESS_TABLE]: [
        { data: [target()], error: null },
        { data: null, error: null },
        { data: null, error: null, count: 0 } as never,
      ],
      pinnacle_sales: [
        { data: [{ id: "0xa_111" }], error: null }, // pre-read: 0xa already ingested
        { error: { code: "23505", message: "duplicate key value" } }, // chunk insert races
        { error: { code: "23505", message: "duplicate key value" } }, // row insert raced too
      ],
    })

    const res = await POST(req())
    const upd = (spy.writes[PROGRESS_TABLE] ?? []).flatMap((w) => w.rows)
    expect(upd[0]).toMatchObject({ status: "done", sales_inserted: 0, dupes_skipped: 2 })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 2, p_rows_written: 0, p_rows_skipped: 2 })
    expect(await res.json()).toMatchObject({ sales_inserted: 0, dupes_skipped: 2 })
  })
})

describe("pinnacle-studio-sales-history-backfill — dryRun probe", () => {
  it("400s without a numeric &edition=, then probes end-to-end writing NOTHING and logging nothing", async () => {
    install({})
    const bad = await POST(req("?dryRun=true"))
    expect(bad.status).toBe(400)

    fetchMock = installFetchMock([
      studioStub([
        histPage([goodNode()], { total: 9 }),
      ]),
    ])
    const spy = install({})
    const res = await POST(req("?dryRun=true&edition=999"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      edition: 999,
      studio_total: 9,
      pages: 1,
      scanned: 1,
    })
    expect(body.sample[0]).toMatchObject({ price: 250000000, soldAt: "2025-06-01T00:00:00Z", render: "r1-node", tx: true })
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
  })
})
