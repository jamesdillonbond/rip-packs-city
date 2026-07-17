import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
  type RecordedRpcCall,
} from "./helpers/route-harness"

// Deep-drive of /api/cron/ufc-studio-sales-history-backfill — the single
// GLOBAL-CURSOR studio-GQL walk (UFC has no edition filter upstream — DRIFT vs
// the per-render/per-edition queues of its siblings). Pinned contracts:
//   - in-process edition resolution via the (lower(athlete)|edition_size) map;
//     COLLIDING keys resolve to null and are never written; uncataloged
//     athletes are scanned-but-skipped;
//   - the exact `sales` row: source='ufc_studio_history_v1', marketplace
//     'ufcstrike', price DUC/1e8, serial from nft.edition_num, block_height
//     from created_at;
//   - the walk resumes from the persisted after_cursor and checkpoints
//     flush-then-cursor (state.after_cursor lands only after its matched sales
//     were written); cumulative accounting adds this tick onto the stored
//     totals; the final page flips done=true;
//   - dedup: pre-read against existing sales by transaction_hash → dupes;
//   - fatal GQL errors persist best-effort progress + the error, log ok=false,
//     and 500; edition-map load failure is its own 500;
//   - control paths: auth, disabled, reset, walk_complete; dryRun probes from a
//     FRESH cursor and writes/logs nothing.

const state = vi.hoisted(() => ({
  sb: null as unknown,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "ufc-studio-token"
const { POST } = await import("@/app/api/cron/ufc-studio-sales-history-backfill/route")

const UFC = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const STATE_TABLE = "ufc_studio_sales_history_state"

interface UfcNodeLike {
  nft_id?: string | null
  sales_price?: string | null
  price?: string | null
  purchased?: boolean | null
  receiver_address?: string | null
  created_at?: { block_height: string | null; block_time: string | null; transaction_hash: string | null } | null
  nft?: { edition_num: string | null; set: { metadata: { athlete_name: string | null; edition_size: string | null } | null } | null } | null
}

function node(over: Partial<UfcNodeLike> & { athlete?: string | null; size?: string | null } = {}): UfcNodeLike {
  const { athlete, size, ...rest } = over
  return {
    nft_id: "555",
    sales_price: "1500000000", // DUC → $15
    price: null,
    purchased: true,
    receiver_address: null,
    created_at: { block_height: "12345", block_time: "2023-01-01T00:00:00Z", transaction_hash: "0xtx1" },
    nft: {
      edition_num: "7",
      set: { metadata: { athlete_name: athlete ?? "Israel Adesanya", edition_size: size ?? "500" } },
    },
    ...rest,
  }
}

function histPage(
  nodes: UfcNodeLike[],
  opts: { total?: number; endCursor?: string | null; hasNextPage?: boolean } = {},
) {
  return {
    data: {
      searchUFCMarketplaceHistory: {
        totalCount: opts.total ?? nodes.length,
        pageInfo: { endCursor: opts.endCursor ?? null, hasNextPage: opts.hasNextPage ?? false },
        edges: nodes.map((n) => ({ node: n })),
      },
    },
  }
}

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

const EDITION_ROWS = [
  { id: "ed-adesanya", player_name: "Israel Adesanya", circulation_count: 500 },
  // Deliberate collision: two Jon Jones editions with the same circ — the map
  // must mark the key ambiguous (null) so neither is ever written.
  { id: "ed-jones-a", player_name: "Jon Jones", circulation_count: 100 },
  { id: "ed-jones-b", player_name: "Jon Jones", circulation_count: 100 },
]

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(qs = "", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`https://t/api/cron/ufc-studio-sales-history-backfill${qs}`, {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer ufc-studio-token" }),
  })
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ufc-studio-token"
  delete process.env.UFC_STUDIO_SALES_HISTORY_BACKFILL_DISABLED
  delete process.env.CRON_SECRET
})

describe("ufc-studio-sales-history-backfill — control paths", () => {
  it("401s without the token; the kill-switch logs an honest ok run", async () => {
    const spy = install({})
    expect((await POST(req("", {}))).status).toBe(401)
    expect(spy.rpcCalls).toHaveLength(0)

    process.env.UFC_STUDIO_SALES_HISTORY_BACKFILL_DISABLED = "1"
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, skipped: "disabled" })
    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({ p_ok: true, p_collection_slug: "ufc_strike" })
    expect((log?.p_extra as Record<string, unknown>).skipped).toBe("disabled")
  })

  it("?reset=true clears the walk state (cursor + counters + done) and logs mode=reset", async () => {
    const spy = install({ [STATE_TABLE]: { data: null, error: null } })
    const res = await POST(req("?reset=true"))
    expect(await res.json()).toMatchObject({ ok: true, mode: "reset" })
    const upd = (spy.writes[STATE_TABLE] ?? []).flatMap((w) => w.rows)
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({
      after_cursor: null,
      pages_walked: 0,
      rows_scanned: 0,
      rows_matched: 0,
      sales_inserted: 0,
      done: false,
      error: null,
      last_block_time: null,
    })
    expect(terminalLog(spy.rpcCalls)?.p_extra).toMatchObject({ mode: "reset" })
  })

  it("a completed walk short-circuits as walk_complete without loading the edition map or fetching", async () => {
    fetchMock = installFetchMock([studioStub([histPage([])])])
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 0 } as never,
      [STATE_TABLE]: { data: { done: true }, error: null },
    })
    const res = await POST(req())
    expect(await res.json()).toMatchObject({ ok: true, note: "walk_complete" })
    expect((terminalLog(spy.rpcCalls)?.p_extra as Record<string, unknown>).note).toBe("walk_complete")
    expect(fetchMock.calls).toHaveLength(0)
  })

  it("an edition-map load failure is its own honest 500 (logged ok=false), not a silent empty map", async () => {
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 0 } as never,
      [STATE_TABLE]: { data: { after_cursor: null, done: false }, error: null },
      editions: { data: null, error: { message: "permission denied" } },
    })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, error: "edition_map" })
    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(String(log?.p_error)).toBe("edition_map: permission denied")
  })
})

describe("ufc-studio-sales-history-backfill — cursor walk + write", () => {
  it("resumes from the stored cursor, resolves via the athlete|size map (ambiguous keys skipped), dedups, checkpoints flush-then-cursor, flips done", async () => {
    fetchMock = installFetchMock([
      studioStub([
        histPage(
          [
            node(), // matched -> insert
            node({ nft_id: "556", athlete: "Jon Jones", size: "100", created_at: { block_height: "12346", block_time: "2023-01-01T01:00:00Z", transaction_hash: "0xtx2" } }), // ambiguous key -> skipped
            node({ nft_id: "557", athlete: "Unknown Guy", size: "10", created_at: { block_height: "12347", block_time: "2023-01-01T02:00:00Z", transaction_hash: "0xtx3" } }), // uncataloged -> skipped
            node({ nft_id: "558", purchased: false }), // unpurchased -> skipped
            node({ nft_id: "559", created_at: { block_height: "12348", block_time: "2023-01-02T00:00:00Z", transaction_hash: "0xdup" } }), // matched but already ingested
          ],
          { total: 860_000, endCursor: "cursor-end", hasNextPage: false },
        ),
      ]),
    ])
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 0 } as never,
      [STATE_TABLE]: {
        data: { after_cursor: "c-prev", pages_walked: 10, rows_scanned: 2000, rows_matched: 40, sales_inserted: 5, done: false },
        error: null,
      },
      editions: { data: EDITION_ROWS, error: null },
      sales: [
        { data: [{ transaction_hash: "0xdup" }], error: null }, // pre-read: dup exists
        { data: null, error: null }, // insert ok
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(200)

    // The walk resumed from the persisted cursor.
    const gqlBody = JSON.parse(String(fetchMock.calls.find((c) => c.url.includes("studio-platform"))?.init?.body))
    expect(gqlBody.variables.in.after).toBe("c-prev")

    const saleRows = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleRows).toHaveLength(1)
    expect(saleRows[0]).toMatchObject({
      edition_id: "ed-adesanya",
      collection_id: UFC,
      collection: "ufc_strike",
      nft_id: "555",
      serial_number: 7,
      price_usd: 15, // 1,500,000,000 DUC / 1e8
      currency: "USD",
      marketplace: "ufcstrike",
      source: "ufc_studio_history_v1",
      block_height: 12345,
      transaction_hash: "0xtx1",
      sold_at: "2023-01-01T00:00:00Z",
    })

    // Final-page checkpoint: cursor persists AFTER the flush, done flips true,
    // cumulative counters add this tick onto the stored totals.
    const stateUpd = (spy.writes[STATE_TABLE] ?? []).flatMap((w) => w.rows)
    expect(stateUpd).toHaveLength(1)
    expect(stateUpd[0]).toMatchObject({
      after_cursor: "cursor-end",
      pages_walked: 11,
      rows_scanned: 2005,
      rows_matched: 42, // 0xtx1 + 0xdup both matched
      sales_inserted: 6, // 5 stored + 1 this tick
      studio_total: 860_000,
      last_block_time: "2023-01-02T00:00:00Z",
      done: true,
      error: null,
    })

    const log = terminalLog(spy.rpcCalls)
    expect(log).toMatchObject({
      p_ok: true,
      p_rows_found: 5, // scanned this tick
      p_rows_written: 1,
      p_rows_skipped: 1, // the dedup
      p_collection_slug: "ufc_strike",
    })
    expect(log?.p_extra).toMatchObject({
      pages_this_tick: 1,
      matched_this_tick: 2,
      walk_done: true,
      budget_hit: false,
      studio_total: 860_000,
      last_block_time: "2023-01-02T00:00:00Z",
      cumulative_inserted: 6,
    })
    expect(await res.json()).toMatchObject({
      ok: true,
      pages_this_tick: 1,
      scanned_this_tick: 5,
      matched_this_tick: 2,
      sales_inserted: 1,
      dupes_skipped: 1,
      walk_done: true,
      cumulative_inserted: 6,
    })
  })

  it("a fatal GQL error persists best-effort progress with the error, logs ok=false, and 500s", async () => {
    fetchMock = installFetchMock([studioStub([], { status: 500 })])
    const spy = install({
      pipeline_runs: { data: [], error: null, count: 0 } as never,
      [STATE_TABLE]: { data: { after_cursor: null, pages_walked: 3, rows_scanned: 600, done: false }, error: null },
      editions: { data: EDITION_ROWS, error: null },
    })

    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("GQL 500")

    // Best-effort persistence: pages/rows counters + the error, NOT the cursor
    // (unflushed candidates must be re-found next tick).
    const stateUpd = (spy.writes[STATE_TABLE] ?? []).flatMap((w) => w.rows)
    expect(stateUpd).toHaveLength(1)
    expect(stateUpd[0]).toMatchObject({ pages_walked: 3, rows_scanned: 600, error: "GQL 500" })
    expect(stateUpd[0]).not.toHaveProperty("after_cursor")

    const log = terminalLog(spy.rpcCalls)
    expect(log?.p_ok).toBe(false)
    expect(log?.p_error).toBe("GQL 500")
    expect(spy.writes.sales ?? []).toHaveLength(0)
  })
})

describe("ufc-studio-sales-history-backfill — dryRun probe", () => {
  it("walks from a FRESH cursor, reports match/scan stats, and writes/logs NOTHING", async () => {
    fetchMock = installFetchMock([
      studioStub([
        histPage(
          [
            node(),
            node({ nft_id: "557", athlete: "Unknown Guy", size: "10" }), // not in map -> not sampled
          ],
          { total: 860_000 },
        ),
      ]),
    ])
    const spy = install({
      editions: { data: EDITION_ROWS, error: null },
    })

    const res = await POST(req("?dryRun=true&pages=1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "dryRun",
      pages: 1,
      studio_total: 860_000,
      scanned: 2,
      matched: 1,
      edition_map_size: 2, // adesanya + the (ambiguous) jones key
    })
    expect(body.sample).toEqual([
      { athlete: "Israel Adesanya", size: "500", price: 1500000000, soldAt: "2023-01-01T00:00:00Z", matched: true },
    ])
    // dryRun starts from a fresh cursor — no `after` in the request...
    const gqlBody = JSON.parse(String(fetchMock.calls[0]?.init?.body))
    expect(gqlBody.variables.in.after).toBeUndefined()
    // ...and is a pure probe: no writes, no pipeline_runs.
    expect(Object.keys(spy.writes)).toHaveLength(0)
    expect(spy.rpcCalls).toHaveLength(0)
  })
})
