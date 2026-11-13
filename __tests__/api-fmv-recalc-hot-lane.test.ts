import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// The hot lane (2026-11-12). The sweep order is frozen when a sweep starts, so an
// edition that sells mid-sweep waited hours for a price that reflects the sale
// (after 7 quiet days: p50 8-9 h, p90 ~24 h). Each run now also prices the
// editions fmv_recalc_hot_editions returns. What must hold:
//   - hot editions are PRICED this run (their ids reach the sales read) …
//   - … without moving the cursor: page_size / has_more stay the page's own;
//   - a FAILED hot read prices the page exactly as before and is RECORDED as a
//     failure beside the count — never a silent "0 hot editions".

const state = vi.hoisted(() => ({ afterCbs: [] as Array<() => unknown>, sb: null as unknown }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))

const { POST } = await import("@/app/api/fmv-recalc/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function req(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/fmv-recalc", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", authorization: "Bearer ingest-secret" }),
    body: JSON.stringify(body),
  })
}
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const sale = (ed: string, price: number, serial: number, age: number) => ({
  edition_id: ed, collection_id: TOPSHOT, price_usd: price, sold_at: daysAgo(age), serial_number: serial,
})
const fourSales = (ed: string) => [sale(ed, 10, 300, 1), sale(ed, 10, 400, 3), sale(ed, 10, 500, 6), sale(ed, 10, 600, 10)]
const meta = (id: string, ext: string) => ({ id, tier: "COMMON", circulation_count: 1000, external_id: ext, jersey_number: null })

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

function fixtures(over: Fixtures): Fixtures {
  return {
    pipeline_runs: { data: null, error: null },
    "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-page" }], error: null },
    editions: { data: [meta("ed-page", "1:100"), meta("ed-hot", "1:101")], error: null },
    edition_offers: { data: [], error: null },
    fmv_snapshots: { data: [], error: null },
    "rpc:query_sql": { data: [], error: null },
    "rpc:fmv_apply_thin_sale_haircut": { data: [{ rows_examined: 0, rows_haircut: 0, total_dollars_removed: 0 }], error: null },
    "rpc:fmv_apply_thin_sale_haircut_for_editions": { data: [{ rows_examined: 0, rows_haircut: 0, dollars_removed: 0 }], error: null },
    "rpc:apply_fmv_thin_sales_guard": { data: [{ thin_sales_count: 0, stale_count: 0, common_outlier_count: 0, total_caps_applied: 0 }], error: null },
    "rpc:fmv_clamp_disconnected_ask": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
    "rpc:fmv_clamp_disconnected_ask_for_editions": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
    "rpc:purge_fmv_snapshots_today": { data: null, error: null },
    "rpc:log_pipeline_run": { data: null, error: null },
    ...over,
  }
}

/** Instrument, and record the ids of the FIRST sales_market read — Step 1b, the read that decides
 *  what this run prices. (Later steps re-ask by whatever the first read returned, and the fixture
 *  returns every sale regardless of filter, so only the first read can tell the two apart.) */
function instrument(f: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(f)
  const sb = spy.fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = sb.from.bind(sb)
  const salesIdsAsked: string[] = []
  let firstRead = true
  sb.from = (t: string) => {
    const b = baseFrom(t)
    if (t === "sales_market") {
      const baseIn = b.in as (col: string, vals: unknown[]) => unknown
      b.in = (col: string, vals: unknown[]) => {
        if (col === "edition_id" && firstRead) {
          salesIdsAsked.push(...(vals as string[]))
          firstRead = false
        }
        return baseIn.call(b, col, vals)
      }
    }
    return b
  }
  state.sb = spy.fixture
  const inserted = () =>
    (spy.writes.fmv_snapshots ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows.map((r) => String(r.edition_id)))
  return { rpcCalls: spy.rpcCalls, salesIdsAsked, inserted }
}

function terminalExtra(rpcCalls: RecordedRpcCall[]) {
  const args = rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined
  return (args?.p_extra ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  delete process.env.CRON_SECRET
  state.afterCbs.length = 0
})

describe("fmv-recalc — the hot lane", () => {
  it("prices a freshly sold edition this run without counting it into the page", async () => {
    const { rpcCalls, salesIdsAsked, inserted } = instrument(
      fixtures({
        "rpc:fmv_recalc_hot_editions": { data: [{ edition_id: "ed-hot" }, { edition_id: "ed-page" }], error: null },
        sales_market: { data: [...fourSales("ed-page"), ...fourSales("ed-hot")], error: null },
      }),
    )
    await POST(req())
    await runDeferred()

    expect(rpcCalls.some((c) => c.name === "fmv_recalc_hot_editions")).toBe(true)
    // Each id is asked for once per sales read: an edition both hot AND on the page is not doubled.
    expect(salesIdsAsked).toEqual(["ed-page", "ed-hot"])
    expect(inserted()).toContain("ed-hot")
    expect(inserted()).toContain("ed-page")
    const extra = terminalExtra(rpcCalls)
    expect(extra.hot_lane_editions).toBe(1)
    expect(extra.hot_lane_error).toBeNull()
    // The cursor's unit is the PAGE: one page edition, however many rode the lane.
    expect(extra.page_size).toBe(1)
  })

  // 2026-11-13: the test above asserts page_size only; its title also promises the CURSOR is left alone.
  // Discriminating case: limit 2, ONE page edition + ONE hot edition. The cursor advances only when the PAGE
  // fills the limit (hasMore), so it must stay null; counting the hot edition into the page would fill it
  // (1 + 1 = 2) and move the cursor to "2", skipping page editions on the next run.
  it("leaves the sweep cursor where the page alone puts it, however many editions rode the lane", async () => {
    const { rpcCalls, inserted } = instrument(
      fixtures({
        "rpc:fmv_recalc_hot_editions": { data: [{ edition_id: "ed-hot" }], error: null },
        sales_market: { data: [...fourSales("ed-page"), ...fourSales("ed-hot")], error: null },
      }),
    )
    await POST(req({ limit: 2 }))
    await runDeferred()
    expect(inserted()).toContain("ed-hot")
    const args = rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown>
    expect(args.p_cursor_before).toBe("0")
    expect(args.p_cursor_after).toBeNull()
    expect((args.p_extra as Record<string, unknown>).has_more).toBe(false)
  })

  it("a failed hot read prices the page only and records the failure, not a zero", async () => {
    const { rpcCalls, salesIdsAsked, inserted } = instrument(
      fixtures({
        "rpc:fmv_recalc_hot_editions": { data: null, error: { message: "canceling statement due to statement timeout" } },
        sales_market: { data: fourSales("ed-page"), error: null },
      }),
    )
    await POST(req())
    await runDeferred()

    expect(salesIdsAsked).toEqual(["ed-page"])
    expect(inserted()).toContain("ed-page")
    const extra = terminalExtra(rpcCalls)
    expect(extra.hot_lane_editions).toBe(0)
    expect(String(extra.hot_lane_error)).toContain("statement timeout")
  })
})
