import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/cron/topshot-sales-history-backfill — the ASK_ONLY gap
// closer. The route is SYNCHRONOUS (no after(); the 300s gateway cap is the
// limiter), so every contract is observable straight off the response + the
// instrumented Supabase writes. Pinned contracts:
//   - the exact `sales` rows written per drained edition: keyed to the KNOWN
//     target edition (never a GQL-derived one), tagged source
//     'ts_history_backfill_v1' / marketplace 'topshot' / collection
//     'nba_top_shot', with the DETERMINISTIC synthetic tx-hash fallback;
//   - the Phase-4 parallel-redirect: a sale whose nft_id maps to a subedition
//     is re-keyed onto its existing `::subID` edition BEFORE insert (the
//     conflation-leak fix — regressing this re-creates dup-serial conflation);
//   - progress-row advancement (status/attempts/play_uuid/sales_inserted/
//     dupes_skipped/gql_pages) and the terminal log_pipeline_run accounting;
//   - play-uuid resolution ladder: pre-seeded > edition_offers > GQL set-map,
//     and the retryable-vs-frozen (pending vs error + editions_maxed_out)
//     classification when GQL fails;
//   - dedup honesty: pre-read dupes + the 23505 row-by-row fallback both count
//     as dupes_skipped, never as inserts;
//   - control paths: auth, disabled kill-switch, seed mode, saturation
//     self-throttle, queue-empty — each with its own honest pipeline_runs row;
//   - dryRun writes NOTHING and logs nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gqlCalls: [] as Array<{ op: "setmap" | "txs"; variables: Record<string, unknown> | undefined }>,
  setMapPages: [] as Array<{ throwMsg?: string; data?: unknown }>,
  txPages: [] as Array<{ throwMsg?: string; data?: unknown }>,
  setMapIdx: 0,
  txIdx: 0,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

// The route's only upstream seam: topshotGraphql. Dispatch on the query text
// (the two operations have distinct names) with per-op page sequences; an entry
// with throwMsg throws — the lever for the 429/GQL-failure classification paths.
vi.mock("@/lib/topshot", () => ({
  topshotGraphql: async (query: string, variables?: Record<string, unknown>) => {
    const op: "setmap" | "txs" = query.includes("SetPlayMap") ? "setmap" : "txs"
    state.gqlCalls.push({ op, variables })
    const pages = op === "setmap" ? state.setMapPages : state.txPages
    const idx = op === "setmap" ? state.setMapIdx++ : state.txIdx++
    const page = pages[Math.min(idx, pages.length - 1)]
    if (!page) throw new Error(`test fixture: no ${op} page configured`)
    if (page.throwMsg) throw new Error(page.throwMsg)
    return page.data
  },
}))

process.env.INGEST_SECRET_TOKEN = "ts-history-token"
const { POST } = await import("@/app/api/cron/topshot-sales-history-backfill/route")

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const SET_UUID = "11111111-2222-3333-4444-555555555555"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = ""): NextRequest {
  return new NextRequest(`https://t/api/cron/topshot-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ts-history-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

// ── GQL page builders (mirror the route's parse shapes exactly) ──────────────
function setMapPage(plays: Array<{ id: string; flowID: string }>, nextCursor: string | null = null) {
  return {
    searchEditions: {
      searchSummary: {
        pagination: { rightCursor: nextCursor },
        data: { data: plays.map((p) => ({ play: p })) },
      },
    },
  }
}

type TxOver = {
  id?: string
  price?: number | string | null
  updatedAt?: string | null
  txHash?: string | null
  flowId?: string | null
  serial?: string | number | null
  setFlowId?: string | number | null
}
function gqlTx(over: TxOver = {}) {
  return {
    id: over.id ?? "mt-1",
    price: over.price === undefined ? 10 : over.price,
    updatedAt: over.updatedAt === undefined ? "2026-01-15T10:00:00.000Z" : over.updatedAt,
    txHash: over.txHash === undefined ? "0xaaaa0001" : over.txHash,
    moment: {
      flowId: over.flowId === undefined ? "111" : over.flowId,
      flowSerialNumber: over.serial === undefined ? "7" : over.serial,
      set: { flowId: over.setFlowId === undefined ? "12" : over.setFlowId },
    },
  }
}
function txPage(txs: unknown[], nextCursor: string | null = null) {
  return {
    searchMarketplaceTransactions: {
      data: {
        searchSummary: {
          pagination: { rightCursor: nextCursor },
          data: { data: txs },
        },
      },
    },
  }
}

function target(over: Partial<{ edition_id: string; edition_key: string; set_uuid: string | null; play_uuid: string | null; attempts: number }> = {}) {
  return {
    edition_id: over.edition_id ?? "ed-uuid-1",
    edition_key: over.edition_key ?? "12:345",
    set_uuid: over.set_uuid === undefined ? SET_UUID : over.set_uuid,
    play_uuid: over.play_uuid === undefined ? "play-uuid-1" : over.play_uuid,
    attempts: over.attempts ?? 0,
  }
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ts-history-token"
  delete process.env.TS_SALES_HISTORY_BACKFILL_DISABLED
  state.gqlCalls = []
  state.setMapPages = []
  state.txPages = []
  state.setMapIdx = 0
  state.txIdx = 0
})

describe("topshot-sales-history-backfill — control paths", () => {
  it("401s without the ingest token and touches nothing", async () => {
    const spy = install({})
    const res = await POST(
      new NextRequest("https://t/api/cron/topshot-sales-history-backfill", { method: "POST" }),
    )
    expect(res.status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)
    expect(Object.keys(spy.writes)).toHaveLength(0)
  })

  it("kill-switch env skips the tick but still logs an honest ok run", async () => {
    process.env.TS_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0, p_rows_written: 0 })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
    // Disabled means DISABLED — no queue pick, no progress writes.
    expect(spy.writes.topshot_sales_history_backfill_progress ?? []).toHaveLength(0)
  })

  it("seed mode reports the RPC's seeded count as rows_found and does not drain", async () => {
    const spy = install({
      "rpc:seed_topshot_sales_history_targets": { data: 42, error: null },
    })
    const res = await POST(req("?seed=true"))
    expect(await res.json()).toEqual({ ok: true, mode: "seed", seeded: 42 })
    expect(spy.rpcCalls.some((c) => c.name === "seed_topshot_sales_history_targets")).toBe(true)
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 42 })
    expect(log?.p_extra).toMatchObject({ mode: "seed", seeded: 42 })
    // Seed never enters the drain loop.
    expect(state.gqlCalls).toHaveLength(0)
  })

  it("self-throttles when the platform is saturated (>15 non-self fails/30min) and logs the skip", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 16 } as never,
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "saturation", recent_fails: 16 })
    const log = terminalLog(spy.rpcCalls)
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("saturation")
    // The throttle fires BEFORE the queue pick — no GQL, no progress writes.
    expect(state.gqlCalls).toHaveLength(0)
    expect(spy.writes.topshot_sales_history_backfill_progress ?? []).toHaveLength(0)
  })

  it("an empty queue logs queue_empty (the drained-tail terminal state, not an error)", async () => {
    const spy = install({
      topshot_sales_history_backfill_progress: { data: [], error: null },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, note: "queue_empty" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_rows_found: 0 })
    expect((log?.p_extra as Record<string, unknown>).note).toBe("queue_empty")
  })
})

describe("topshot-sales-history-backfill — drain loop", () => {
  it("drains one edition end-to-end: exact sale rows, parallel redirect, synth-hash fallback, progress + log accounting", async () => {
    // Page of 4 txs: A inserts normally; B has no txHash (synth fallback) AND
    // its nft maps to subedition 19 (parallel redirect); C has a null price
    // (filtered); D carries a foreign set flowId (filtered).
    const soldAtB = "2026-02-01T09:30:00.000Z"
    state.txPages = [
      {
        data: txPage([
          gqlTx({ txHash: "0xhash-a", flowId: "111", serial: "7", price: "12.5" }),
          gqlTx({ txHash: null, flowId: "222", serial: null, price: 3, updatedAt: soldAtB }),
          gqlTx({ txHash: "0xhash-c", flowId: "333", price: null }),
          gqlTx({ txHash: "0xhash-d", flowId: "444", setFlowId: "99" }),
        ]),
      },
    ]
    const spy = install({
      topshot_sales_history_backfill_progress: [
        { data: [target()], error: null }, // pick
        { data: null, error: null }, // per-edition progress update
        { data: null, error: null, count: 5 } as never, // pending_remaining
      ],
      topshot_moment_subeditions: { data: [{ nft_id: "222", subedition_id: 19 }], error: null },
      editions: { data: [{ id: "ed-uuid-sub19", external_id: "12:345::19" }], error: null },
      sales: [
        { data: [], error: null }, // existing tx-hash pre-read
        { data: null, error: null }, // chunk insert ok
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // Exact rows written — edition keying, tags, serial handling, redirect.
    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(2)
    expect(saleRows[0]).toEqual({
      edition_id: "ed-uuid-1",
      collection_id: TS,
      collection: "nba_top_shot",
      serial_number: 7,
      price_usd: 12.5,
      currency: "USD",
      marketplace: "topshot",
      source: "ts_history_backfill_v1",
      transaction_hash: "0xhash-a",
      sold_at: "2026-01-15T10:00:00.000Z",
      nft_id: "111",
    })
    // B: redirected onto the `::19` parallel edition + deterministic synth hash
    // (setInt:playUuid:serial0:epoch:seq — re-runs must dedup against themselves).
    const epochB = Math.floor(new Date(soldAtB).getTime() / 1000)
    expect(saleRows[1]).toMatchObject({
      edition_id: "ed-uuid-sub19",
      serial_number: 0,
      price_usd: 3,
      transaction_hash: `tshist:12:play-uuid-1:0:${epochB}:0`,
      nft_id: "222",
    })

    // Progress row advanced with the full per-edition accounting.
    const upd = (spy.writes.topshot_sales_history_backfill_progress ?? []).flatMap((w) => w.rows)
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({
      status: "done",
      attempts: 1,
      play_uuid: "play-uuid-1",
      sales_inserted: 2,
      dupes_skipped: 0,
      gql_pages: 1,
      error: null,
    })

    // Terminal log: found counts EVERY tx seen (incl. the 2 filtered ones).
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 4,
      p_rows_written: 2,
      p_rows_skipped: 0,
      p_collection_slug: "nba_top_shot",
    })
    expect(log?.p_extra).toMatchObject({
      editions_processed: 1,
      editions_drained: 1,
      editions_empty: 0,
      editions_error: 0,
      gql_errors: 0,
      budget_hit: false,
      pending_remaining: 5,
    })
    expect(await res.json()).toMatchObject({
      ok: true,
      sales_inserted: 2,
      dupes_skipped: 0,
      editions_drained: 1,
      pending_remaining: 5,
    })
    // play_uuid was pre-seeded — the expensive GQL set-map walk must not fire.
    expect(state.gqlCalls.filter((c) => c.op === "setmap")).toHaveLength(0)
  })

  it("resolves a missing play_uuid from edition_offers (cheap ladder rung) and persists it on the empty-status progress row", async () => {
    state.txPages = [{ data: txPage([]) }] // zero-history target
    const spy = install({
      topshot_sales_history_backfill_progress: [
        { data: [target({ play_uuid: null })], error: null },
        { data: null, error: null },
        { data: null, error: null, count: 0 } as never,
      ],
      edition_offers: { data: { play_uuid: "pu-offers" }, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // Resolution came from edition_offers, NOT the GQL set-map walk.
    expect(state.gqlCalls.filter((c) => c.op === "setmap")).toHaveLength(0)
    const upd = (spy.writes.topshot_sales_history_backfill_progress ?? []).flatMap((w) => w.rows)
    expect(upd[0]).toMatchObject({
      status: "empty",
      play_uuid: "pu-offers", // persisted so it's resolved once, ever
      gql_pages: 1,
      sales_inserted: 0,
    })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).editions_empty).toBe(1)
  })

  it("classifies GQL failures: retryable stays pending; the 4th attempt freezes to error and counts editions_maxed_out", async () => {
    // t1 (attempts 0): no play_uuid, offers miss -> set-map walk throws (429).
    // t2 (attempts 3 = MAX-1): tx fetch throws -> frozen in error status.
    state.setMapPages = [{ throwMsg: "topshot gql HTTP 429" }]
    state.txPages = [{ throwMsg: "topshot gql HTTP 429" }]
    const spy = install({
      topshot_sales_history_backfill_progress: [
        {
          data: [
            target({ edition_id: "ed-t1", edition_key: "12:345", play_uuid: null }),
            target({ edition_id: "ed-t2", edition_key: "12:346", attempts: 3 }),
          ],
          error: null,
        },
        { data: null, error: null }, // t1 update
        { data: null, error: null }, // t2 update
        { data: null, error: null, count: 2 } as never,
      ],
      edition_offers: { data: null, error: null }, // offers miss for t1
    })

    const res = await POST(req())
    const upd = (spy.writes.topshot_sales_history_backfill_progress ?? []).flatMap((w) => w.rows)
    expect(upd).toHaveLength(2)
    // Retryable failure below the attempt cap: stays in the pending pick pool.
    expect(upd[0]).toMatchObject({ status: "pending", attempts: 1 })
    expect(String(upd[0].error)).toMatch(/^setmap: /)
    // Attempt cap reached on a retryable error: frozen loudly, not silently.
    expect(upd[1]).toMatchObject({ status: "error", attempts: 4 })
    expect(String(upd[1].error)).toMatch(/^gql: /)

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_extra).toMatchObject({
      editions_processed: 2,
      editions_error: 1,
      editions_maxed_out: 1,
      gql_errors: 2,
    })
    expect(await res.json()).toMatchObject({ editions_maxed_out: 1, gql_errors: 2 })
  })

  it("dedup honesty: pre-read dupes and 23505 row-by-row fallback both count as dupes_skipped, never inserts", async () => {
    state.txPages = [
      {
        data: txPage([
          gqlTx({ txHash: "h1", flowId: "111" }),
          gqlTx({ txHash: "h2", flowId: "222" }),
          gqlTx({ txHash: "h3", flowId: "333" }),
        ]),
      },
    ]
    const spy = install({
      topshot_sales_history_backfill_progress: [
        { data: [target()], error: null },
        { data: null, error: null },
        { data: null, error: null, count: 0 } as never,
      ],
      topshot_moment_subeditions: { data: [], error: null },
      sales: [
        { data: [{ transaction_hash: "h1" }], error: null }, // h1 already ingested
        { error: { code: "23505", message: "duplicate key value" } }, // chunk hits the partial-unique race
        { data: null, error: null }, // row h2 lands
        { error: { code: "23505", message: "duplicate key value" } }, // row h3 raced in elsewhere
      ],
    })

    const res = await POST(req())
    const upd = (spy.writes.topshot_sales_history_backfill_progress ?? []).flatMap((w) => w.rows)
    expect(upd[0]).toMatchObject({ status: "done", sales_inserted: 1, dupes_skipped: 2 })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_rows_found: 3, p_rows_written: 1, p_rows_skipped: 2 })
    expect(await res.json()).toMatchObject({ sales_inserted: 1, dupes_skipped: 2 })
  })
})

describe("topshot-sales-history-backfill — dryRun probe", () => {
  it("validates the edition param, then probes end-to-end writing NOTHING and logging nothing", async () => {
    install({})
    const bad = await POST(req("?dryRun=true"))
    expect(bad.status).toBe(400)

    state.setMapPages = [{ data: setMapPage([{ id: "pu-x", flowID: "345" }]) }]
    state.txPages = [{ data: txPage([gqlTx({ txHash: "h9", price: "42" })]) }]
    const spy = install({
      editions: { data: { id: "ed-1", set_id: "set-row-1" }, error: null },
      sets: { data: { external_id: "12345678-1234-1234-1234-123456789abc" }, error: null },
    })
    const res = await POST(req("?dryRun=true&edition=12:345"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      edition: "12:345",
      setUuid: "12345678-1234-1234-1234-123456789abc",
      playUuid: "pu-x",
      set_plays: 1,
      pages: 1,
      total_txs: 1,
    })
    expect(body.sample[0]).toMatchObject({ price: 42, serial: "7", txHash: true })
    // The dryRun contract: zero writes, zero pipeline_runs rows.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.topshot_sales_history_backfill_progress ?? []).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
  })
})
