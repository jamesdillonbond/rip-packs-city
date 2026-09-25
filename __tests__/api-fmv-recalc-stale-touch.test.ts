import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Two fmv-recalc sweep steps the deep-loop test doesn't reach, both of which
// exist to stop the published FMV from LYING in a specific way:
//
//   Step 7 — the ?force_stale=true "stale touch". It re-stamps genuinely COLD
//     editions (no recent sales) with their own last computed values so a
//     freshness monitor doesn't read them as a stall. The load-bearing detail is
//     what it EXCLUDES: editions that traded recently are owned by Step 1's real
//     recompute, so touching them would overwrite a fresh price with a stale
//     copy. It is also delete-then-insert (never upsert) per the fmv_snapshots
//     write contract, and every arm of it is non-fatal.
//   The 90-day EXTENSION for thin editions. An edition with fewer than
//     TYPICAL_SERIAL_MIN (3) typical-serial sales in the 30-day window widens to
//     90 days — but only ADOPTS the wider set when it genuinely adds depth, so a
//     window widening can never shrink the sample an FMV is based on.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  /** query_sql rows keyed by a substring of the SQL text. */
  querySqlByMarker: {} as Record<string, { data: unknown; error: unknown }>,
  /** Every query_sql text the route sent (the marker dispatch answers before the spy records it). */
  querySqlSeen: [] as string[],
}))

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

function req(qs = ""): NextRequest {
  return new NextRequest(`https://t/api/fmv-recalc${qs}`, {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", authorization: "Bearer ingest-secret" }),
    body: JSON.stringify({}),
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]

/** Instrument, and dispatch query_sql by SQL marker so the stale-touch probe
 *  can return rows while every other query_sql step stays quiet. */
function instrument(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  const baseRpc = (spy.fixture as { rpc: (n: string, a?: Record<string, unknown>) => Promise<unknown> }).rpc.bind(spy.fixture)
  ;(spy.fixture as { rpc: (n: string, a?: Record<string, unknown>) => Promise<unknown> }).rpc = async (name, args) => {
    if (name === "query_sql") {
      const sql = String((args as { query?: unknown } | undefined)?.query ?? "")
      state.querySqlSeen.push(sql)
      for (const [marker, payload] of Object.entries(state.querySqlByMarker)) {
        if (sql.includes(marker)) return payload
      }
    }
    return baseRpc(name, args)
  }
  state.sb = spy.fixture
  const inserted = new Proxy({} as Record<string, Record<string, unknown>[]>, {
    get: (_t, table) => (spy.writes[String(table)] ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows),
  })
  return { rpcCalls: spy.rpcCalls, writes: spy.writes, inserted }
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}
function sale(price: number, serial: number, ageDays: number) {
  return { edition_id: "ed-1", collection_id: TOPSHOT, price_usd: price, sold_at: daysAgo(ageDays), serial_number: serial }
}

const EDITION_META = {
  data: [{ id: "ed-1", tier: "COMMON", circulation_count: 1000, external_id: "1:100", jersey_number: null }],
  error: null,
}
const QUIET_TAIL = {
  "rpc:query_sql": { data: [], error: null },
  "rpc:fmv_apply_thin_sale_haircut": { data: [{ rows_examined: 0, rows_haircut: 0, total_dollars_removed: 0 }], error: null },
  "rpc:fmv_apply_thin_sale_haircut_for_editions": { data: [{ rows_examined: 0, rows_haircut: 0, dollars_removed: 0 }], error: null },
  "rpc:apply_fmv_thin_sales_guard": { data: [{ thin_sales_count: 0, stale_count: 0, common_outlier_count: 0, total_caps_applied: 0 }], error: null },
  "rpc:fmv_clamp_disconnected_ask": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
  "rpc:fmv_clamp_disconnected_ask_for_editions": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
  "rpc:purge_fmv_snapshots_today": { data: null, error: null },
  "rpc:log_pipeline_run": { data: null, error: null },
}

function staleRow(editionId: string, fmv: number) {
  return {
    edition_id: editionId,
    collection_id: TOPSHOT,
    fmv_usd: fmv,
    floor_price_usd: fmv,
    asp_usd: fmv,
    asp_without_outliers: fmv,
    liquidity_rating: "LOW",
    confidence: "LOW",
    ask_proxy_fmv: null,
    sales_count_7d: 0,
    sales_count_30d: 0,
    days_since_sale: 200,
    computed_at: daysAgo(40),
  }
}

function terminalLog(rpcCalls: RecordedRpcCall[]) {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args as Record<string, unknown> | undefined
}

/** A minimal single-edition sweep; callers override pieces. */
function baseFixtures(over: Fixtures = {}): Fixtures {
  return {
    pipeline_runs: { data: null, error: null },
    "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
    sales: { data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10)], error: null },
    editions: EDITION_META,
    edition_offers: { data: [], error: null },
    fmv_snapshots: { data: [], error: null },
    ...QUIET_TAIL,
    ...over,
  }
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  delete process.env.CRON_SECRET
  state.afterCbs.length = 0
  state.querySqlByMarker = {}
  state.querySqlSeen.length = 0
})

describe("fmv-recalc — Step 7 stale touch (?force_stale=true)", () => {
  it("does not run at all without the flag", async () => {
    state.querySqlByMarker = { recent_traded: { data: [staleRow("cold-1", 5)], error: null } }
    const { rpcCalls } = instrument(baseFixtures())
    await POST(req())
    await runDeferred()
    // The stale-touch probe is the only query_sql carrying `recent_traded`.
    expect(rpcCalls.filter((c) => c.name === "query_sql" && String((c.args as { query?: unknown })?.query ?? "").includes("recent_traded"))).toHaveLength(0)
  })

  it("re-stamps cold editions with their own last values, delete-then-insert", async () => {
    state.querySqlByMarker = { recent_traded: { data: [staleRow("cold-1", 5), staleRow("cold-2", 7.25)], error: null } }
    const { writes, inserted } = instrument(baseFixtures())

    await POST(req("?force_stale=true"))
    await runDeferred()

    const touched = (inserted.fmv_snapshots ?? []).filter((r) => String(r.edition_id).startsWith("cold-"))
    expect(touched).toHaveLength(2)
    // Values are copied forward verbatim under the CURRENT algo version — the
    // touch re-stamps freshness, it does not re-price.
    expect(touched.find((r) => r.edition_id === "cold-2")).toMatchObject({
      fmv_usd: 7.25,
      confidence: "LOW",
      // The AGE is not copied: the prior row said 200 days when it was written
      // 40 days ago, so today the edition is 240 days cold (no sale to name).
      days_since_sale: 240,
      sales_count_30d: 0,
      algo_version: "1.7.0",
    })
    // fmv_snapshots is delete-then-insert, never upsert (the write contract).
    expect((writes.fmv_snapshots ?? []).some((w) => w.method === "upsert")).toBe(false)
  })

  // ⛔ 2026-09-25 — THE FOSSIL. Candy "Bobby Witt Jr. — BLUE" was priced off a
  // 90d-widened set of 7 sales, the last one 2026-08-08; every night since it
  // went cold the touch re-stamped `sales_count_30d = 7, days_since_sale = 30`
  // verbatim, so the edition page read "7 sales in the last 30 days · 30d since
  // last" 47 days after the last sale — and the DB trigger that zeroes a count
  // whose own age exceeds 30 never fired, because the frozen age never did.
  // 426 latest rows across four collections carried the same signature.
  it("a re-stamp publishes ZERO 30d sales and the TRUE age from the last sale, never the prior row's", async () => {
    const fossil = {
      ...staleRow("cold-fossil", 136.76),
      confidence: "MEDIUM",
      sales_count_7d: 7,
      sales_count_30d: 7,
      days_since_sale: 30,
      computed_at: daysAgo(1),
      last_sold_at: daysAgo(47),
    }
    state.querySqlByMarker = { recent_traded: { data: [fossil], error: null } }
    const { inserted } = instrument(baseFixtures())

    await POST(req("?force_stale=true"))
    await runDeferred()

    // The probe asks the database for the true last sale.
    const probe = state.querySqlSeen.find((q) => q.includes("recent_traded"))
    expect(probe ?? "").toMatch(/max\(s\.sold_at\)[\s\S]*AS last_sold_at/)

    const row = (inserted.fmv_snapshots ?? []).find((r) => r.edition_id === "cold-fossil")
    expect(row).toMatchObject({ fmv_usd: 136.76, confidence: "MEDIUM" })
    // Every touched row matched `rt.edition_id IS NULL`: no sale in 30 days.
    expect(row?.sales_count_30d).toBe(0)
    expect(row?.sales_count_7d).toBe(0)
    // 47 days, from the sale — not 30, not 31 (prior + elapsed), not null.
    expect(row?.days_since_sale).toBe(47)
  })

  it("demotes a cold HIGH edition to MEDIUM on re-stamp (no HIGH without recent sales)", async () => {
    // Every stale-touch row matched `rt.edition_id IS NULL` — zero sales in the
    // recent 30d window — so a preserved HIGH is a fossil that bypasses the
    // volume gate the main-loop write applies. The re-stamp must demote it.
    const coldHigh = { ...staleRow("cold-high", 40), confidence: "HIGH", days_since_sale: 45 }
    const coldMedium = { ...staleRow("cold-med", 12), confidence: "MEDIUM", days_since_sale: 45 }
    state.querySqlByMarker = { recent_traded: { data: [coldHigh, coldMedium], error: null } }
    const { inserted } = instrument(baseFixtures())

    await POST(req("?force_stale=true"))
    await runDeferred()

    const touched = inserted.fmv_snapshots ?? []
    // The fossil HIGH is demoted; the value is still carried forward verbatim.
    expect(touched.find((r) => r.edition_id === "cold-high")).toMatchObject({
      fmv_usd: 40,
      confidence: "MEDIUM",
    })
    // A cold MEDIUM passes through untouched (the gate only demotes HIGH).
    expect(touched.find((r) => r.edition_id === "cold-med")).toMatchObject({
      fmv_usd: 12,
      confidence: "MEDIUM",
    })
  })

  it("stays non-fatal when the stale-touch probe itself errors", async () => {
    state.querySqlByMarker = { recent_traded: { data: null, error: { message: "query_sql timeout" } } }
    const { rpcCalls, inserted } = instrument(baseFixtures())

    await POST(req("?force_stale=true"))
    await runDeferred()

    expect(terminalLog(rpcCalls)).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: true })
    expect((inserted.fmv_snapshots ?? []).filter((r) => String(r.edition_id).startsWith("cold-"))).toHaveLength(0)
  })

  it("is a clean no-op when no edition is cold enough to need a touch", async () => {
    state.querySqlByMarker = { recent_traded: { data: [], error: null } }
    const { rpcCalls, inserted } = instrument(baseFixtures())

    await POST(req("?force_stale=true"))
    await runDeferred()

    expect(terminalLog(rpcCalls)).toMatchObject({ p_ok: true })
    expect((inserted.fmv_snapshots ?? []).filter((r) => String(r.edition_id).startsWith("cold-"))).toHaveLength(0)
  })
})

describe("fmv-recalc — the 90-day extension for thin editions", () => {
  // circ 1000 -> the low-serial threshold puts serials in the hundreds in the
  // "typical" band; two typical sales is under TYPICAL_SERIAL_MIN (3), so the
  // edition qualifies for the widen.
  const thin = [sale(10, 300, 2), sale(12, 400, 5)]

  // ⚠ 2026-09-25 — these four used to read the widening off `sales_count_30d`
  // ("5 sales after the widen, not the 2 the 30-day window saw"), which pinned
  // the DEFECT: the 90d sample size was being PUBLISHED as the 30-day count,
  // and the edition page rendered it as "N sales in the last 30 days". The
  // widening is now observed through the PRICE it changes (floor_price_usd is
  // min over the priced set), and the count is pinned to the TRUE 30d count.

  it("adopts the wider window only when it genuinely adds depth — and still publishes the TRUE 30d count", async () => {
    const { inserted } = instrument(
      baseFixtures({
        sales: [
          { data: thin, error: null }, // 30-day window
          { data: [...thin, sale(9, 500, 40), sale(11, 600, 55), sale(11, 700, 70)], error: null }, // 90-day widen
          { data: [], error: null },
        ],
      }),
    )
    await POST(req())
    await runDeferred()

    const snap = (inserted.fmv_snapshots ?? []).find((r) => r.edition_id === "ed-1")
    // Priced over the 5-sale widened set: the $9 sale 40 days back is the floor.
    expect(snap?.floor_price_usd).toBe(9)
    // …but only TWO of those sales are inside 30 days, and that is the count
    // the row publishes — in both columns (sales_count_7d mirrors 30d).
    expect(snap?.sales_count_30d).toBe(2)
    expect(snap?.sales_count_7d).toBe(2)
  })

  it("keeps the narrower window when the widen returns no extra depth", async () => {
    const { inserted } = instrument(
      baseFixtures({
        sales: [
          { data: thin, error: null },
          { data: thin, error: null }, // same rows -> no new depth
          { data: [], error: null },
        ],
      }),
    )
    await POST(req())
    await runDeferred()

    const snap = (inserted.fmv_snapshots ?? []).find((r) => r.edition_id === "ed-1")
    expect(snap?.floor_price_usd).toBe(10)
    expect(snap?.sales_count_30d).toBe(2)
  })

  it("falls back to the narrow window when the widen query errors", async () => {
    const { rpcCalls, inserted } = instrument(
      baseFixtures({
        sales: [
          { data: thin, error: null },
          { data: null, error: { message: "90d fetch timeout" } },
          { data: [], error: null },
        ],
      }),
    )
    await POST(req())
    await runDeferred()

    expect(terminalLog(rpcCalls)).toMatchObject({ p_ok: true })
    const snap = (inserted.fmv_snapshots ?? []).find((r) => r.edition_id === "ed-1")
    expect(snap?.floor_price_usd).toBe(10)
    expect(snap?.sales_count_30d).toBe(2)
  })

  it("drops impossible serials (serial > circulation) from the widened set too", async () => {
    const { inserted } = instrument(
      baseFixtures({
        sales: [
          { data: thin, error: null },
          // 9999 > circulation 1000 -> a mis-keyed row, excluded on the way in.
          // Priced at $1 so that, were it adopted, it would BE the floor.
          { data: [...thin, sale(1, 9999, 40), sale(11, 600, 55), sale(11, 700, 70)], error: null },
          { data: [], error: null },
        ],
      }),
    )
    await POST(req())
    await runDeferred()

    const snap = (inserted.fmv_snapshots ?? []).find((r) => r.edition_id === "ed-1")
    expect(snap?.floor_price_usd).toBe(10) // the $1 mis-key never entered the priced set
    expect(snap?.sales_count_30d).toBe(2)
  })
})
