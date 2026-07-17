import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, type RecordedRpcCall } from "./helpers/route-harness"

// Deep-loop test for /api/fmv-recalc — drives the DEFERRED sweep body (the part
// that silently stalled on 2026-05-25) by capturing the after() callback and
// invoking it against sequence-aware Supabase fixtures. The existing tests stop
// at the immediate ack; these assert what the sweep actually computes and — the
// incident class — that EVERY exit path writes a pipeline_runs row, so a failure
// can never again be invisible to cron-silence alerting.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})

// Delegating proxy so each test installs its own fixture into state.sb.
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

const { POST } = await import("@/app/api/fmv-recalc/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function req(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/fmv-recalc", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      authorization: "Bearer ingest-secret",
    }),
    body: JSON.stringify(body),
  })
}

/** Run the captured after() callbacks (the deferred sweep). */
async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

type RpcCall = RecordedRpcCall

/** Install an instrumented fixture as the active supabaseAdmin and return a
 *  flat per-table view of inserted rows (this route only ever inserts). */
function instrument(
  fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0],
  opts: { failInsertTables?: string[] } = {},
) {
  const { fixture, rpcCalls, writes } = makeInstrumentedSupabaseFixture(fixtures, {
    failWrites: opts.failInsertTables,
  })
  state.sb = fixture
  const inserted = new Proxy({} as Record<string, Record<string, unknown>[]>, {
    get: (_t, table) =>
      (writes[String(table)] ?? []).filter((w) => w.method === "insert").flatMap((w) => w.rows),
  })
  return { rpcCalls, inserted }
}

// Sales spread across distinct days so the 10-minute wash-trade clusterer never
// fires; serials in the typical band (threshold for circ 1000 is 100).
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
}
function sale(price: number, serial: number, ageDays: number) {
  return {
    edition_id: "ed-1",
    collection_id: TOPSHOT,
    price_usd: price,
    sold_at: daysAgo(ageDays),
    serial_number: serial,
  }
}

const EDITION_META = {
  data: [
    { id: "ed-1", tier: "COMMON", circulation_count: 1000, external_id: "1:100", jersey_number: null },
  ],
  error: null,
}

// The empty tail every run walks: Step 5/5b/5c/5e/5d query_sql probes + the
// haircut / thin-sales-guard / clamp RPCs.
const QUIET_TAIL = {
  "rpc:query_sql": { data: [], error: null },
  "rpc:fmv_apply_thin_sale_haircut": { data: [{ rows_examined: 0, rows_haircut: 0, total_dollars_removed: 0 }], error: null },
  "rpc:apply_fmv_thin_sales_guard": { data: [{ thin_sales_count: 0, stale_count: 0, common_outlier_count: 0, total_caps_applied: 0 }], error: null },
  "rpc:fmv_clamp_disconnected_ask_topshot": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
  "rpc:purge_fmv_snapshots_today": { data: null, error: null },
  "rpc:log_pipeline_run": { data: null, error: null },
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  delete process.env.CRON_SECRET
  state.afterCbs.length = 0
  state.chained.length = 0
})

function terminalLog(rpcCalls: RpcCall[]): Record<string, unknown> | undefined {
  return rpcCalls.filter((c) => c.name === "log_pipeline_run").at(-1)?.args
}

describe("fmv-recalc deferred sweep — happy path", () => {
  it("prices an edition from its sales, inserts a snapshot, and logs ok=true with a null wrap cursor", async () => {
    const { rpcCalls, inserted } = instrument({
      pipeline_runs: { data: null, error: null }, // cursor read -> offset 0
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      sales: {
        data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15), sale(10, 800, 20)],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    await runDeferred()

    // The heartbeat marker lands under its own pipeline name at sweep entry.
    expect(
      (inserted.pipeline_runs ?? []).some((r) => r.pipeline === "fmv-recalc-heartbeat"),
    ).toBe(true)

    // One snapshot row, priced off the 6x $10 sales: MEDIUM (>=5 sales, <7 for
    // HIGH), fmv = the outlier-filtered WAP = $10, algo 1.7.0.
    const snaps = inserted.fmv_snapshots ?? []
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({
      edition_id: "ed-1",
      collection_id: TOPSHOT,
      fmv_usd: 10,
      floor_price_usd: 10,
      confidence: "MEDIUM",
      sales_count_30d: 6,
      algo_version: "1.7.0",
    })

    // Terminal pipeline_runs row: ok=true, 1 written, cursor wraps (page < limit).
    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({
      p_pipeline: "fmv-recalc",
      p_ok: true,
      p_rows_written: 1,
      p_cursor_after: null,
    })

    // The today-purge ran for the edition before the insert (delete-then-insert).
    const purge = rpcCalls.find((c) => c.name === "purge_fmv_snapshots_today")
    expect(purge?.args?.p_edition_ids).toEqual(["ed-1"])

    // Chain continues to listing-cache.
    expect(state.chained).toEqual([{ path: "/api/listing-cache", chain: false }])
  })

  it("grail dampener: a $9,000 serial-#1 sale cannot own a common edition's FMV", async () => {
    const { inserted } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      sales: {
        data: [sale(9000, 1, 2), sale(6, 300, 1), sale(6, 400, 5), sale(6, 500, 9), sale(6, 600, 14)],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    const snaps = inserted.fmv_snapshots ?? []
    expect(snaps).toHaveLength(1)
    // The grail spike is stripped before pricing: FMV reflects the $6 cluster.
    expect(Number(snaps[0].fmv_usd)).toBeLessThan(10)
    expect(Number(snaps[0].fmv_usd)).toBeCloseTo(6, 1)
  })

  it("mis-key guard: serial > circulation sales are excluded from pricing", async () => {
    const { inserted } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      sales: {
        // 3 impossible serials (> circ 1000) at $500 + 5 real $8 sales.
        data: [
          sale(500, 5000, 1), sale(500, 6000, 2), sale(500, 7000, 3),
          sale(8, 300, 1), sale(8, 400, 5), sale(8, 500, 9), sale(8, 600, 14), sale(8, 700, 18),
        ],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    const snaps = inserted.fmv_snapshots ?? []
    expect(snaps).toHaveLength(1)
    expect(Number(snaps[0].fmv_usd)).toBeCloseTo(8, 1)
    // Only the 5 surviving sales count toward volume.
    expect(snaps[0].sales_count_30d).toBe(5)
  })
})

describe("fmv-recalc deferred sweep — every exit path logs (the 2026-05-25 incident class)", () => {
  it("Step 1a edition-page failure logs ok=false with the stage marker and writes no snapshots", async () => {
    const { rpcCalls, inserted } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: null, error: { message: "canceling statement due to statement timeout" } },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: false })
    expect(String(log?.p_error)).toContain("edition_page_fetch")
    expect((log?.p_extra as Record<string, unknown>)?.stage).toBe("step1a_edition_page")
    expect(inserted.fmv_snapshots ?? []).toHaveLength(0)
  })

  it("an empty page past the end logs a null cursor so the sweep wraps to 0", async () => {
    const { rpcCalls } = instrument({
      // Resume cursor puts the sweep past the end of the table.
      pipeline_runs: { data: { cursor_after: "5000" }, error: null },
      "rpc:fmv_recalc_edition_page": { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({
      p_pipeline: "fmv-recalc",
      p_ok: true,
      p_cursor_before: "5000",
      p_cursor_after: null,
    })
    expect((log?.p_extra as Record<string, unknown>)?.sweep_wrapped).toBe(true)
    expect(state.chained).toEqual([{ path: "/api/listing-cache", chain: false }])
  })

  it("Step 1b all-chunks-failed logs ok=false as saturation-class instead of going dark", async () => {
    const { rpcCalls } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      sales: { data: null, error: { message: "canceling statement due to statement timeout" } },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: false, p_rows_found: 1 })
    expect(String(log?.p_error)).toContain("sales_refetch_failed")
    expect((log?.p_extra as Record<string, unknown>)?.stage).toBe("step1b_refetch_empty")
  })

  it("Step 3 today-purge hard failure logs step3_delete_chunk_failed and aborts before inserting", async () => {
    const { rpcCalls, inserted } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      sales: {
        data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15)],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      ...QUIET_TAIL,
      "rpc:purge_fmv_snapshots_today": { data: null, error: { message: "canceling statement due to lock timeout" } },
    })

    await POST(req())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: false })
    expect(String(log?.p_error)).toContain("step3_delete_chunk_failed")
    // Delete-then-insert discipline: a failed purge must never be followed by
    // an insert (that would double today's rows on the next successful pass).
    expect(inserted.fmv_snapshots ?? []).toHaveLength(0)
    // The purge was retried once (transient-saturation retry) before giving up.
    expect(rpcCalls.filter((c) => c.name === "purge_fmv_snapshots_today")).toHaveLength(2)
  }, 15000)

  it("a throw inside the sweep logs fatal_after_throw instead of dying silently", async () => {
    const { rpcCalls } = instrument(
      {
        pipeline_runs: { data: null, error: null },
        "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
        sales: {
          data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15)],
          error: null,
        },
        editions: EDITION_META,
        edition_offers: { data: [], error: null },
        ...QUIET_TAIL,
      },
      { failInsertTables: ["fmv_snapshots"] },
    )

    await POST(req())
    await runDeferred()

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: false })
    expect(String(log?.p_error)).toContain("forced fmv_snapshots insert failure")
    expect((log?.p_extra as Record<string, unknown>)?.stage).toBe("fatal_after_throw")
  })
})
