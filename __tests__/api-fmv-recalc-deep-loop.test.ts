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

// The empty tail every run walks: Step 5b/5c/5e/5d query_sql probes + the
// haircut / thin-sales-guard / clamp RPCs.
//
// 2026-09-04: Step 5 no longer sends query_sql at all. Its census and its
// candidate list used to be two separate ad-hoc scans over the SAME
// editions × fmv_snapshots anti-join (208,005 buffers a tick); they are now one
// `fmv_recalc_uncovered_editions` call returning a jsonb object, NOT a row set —
// so the quiet default is a payload with an empty `candidates`, and
// `missing_total: 0` is a MEASURED zero (null would mean the read failed).
const QUIET_TAIL = {
  "rpc:query_sql": { data: [], error: null },
  "rpc:fmv_recalc_uncovered_editions": { data: { missing_total: 0, candidates: [] }, error: null },
  "rpc:fmv_recalc_historical_candidates": { data: [], error: null },
  "rpc:fmv_apply_thin_sale_haircut": { data: [{ rows_examined: 0, rows_haircut: 0, total_dollars_removed: 0 }], error: null },
  "rpc:fmv_apply_thin_sale_haircut_for_editions": { data: [{ rows_examined: 0, rows_haircut: 0, dollars_removed: 0 }], error: null },
  "rpc:apply_fmv_thin_sales_guard": { data: [{ thin_sales_count: 0, stale_count: 0, common_outlier_count: 0, total_caps_applied: 0 }], error: null },
  "rpc:fmv_clamp_disconnected_ask": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
  "rpc:fmv_clamp_disconnected_ask_for_editions": { data: [{ rows_clamped: 0, dollars_removed: 0 }], error: null },
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

// ---------------------------------------------------------------------------
// The ASK-fallback / backfill steps. Each is gated on `rows.length > 0` and the
// QUIET_TAIL above returns [] for every query_sql probe, so their bodies never
// executed. `rpc:query_sql` is sequence-aware (an ARRAY of payloads is consumed
// in call order), and the route issues its query_sql calls in a fixed order:
//   0 edition_offers ASK  1 parallel :: ASK  2 All Day ASK  3 tail probe
// Feeding rows at a given index lights exactly that step.
//
// ⚠ THESE INDICES HAVE NOW SHIFTED TWICE ON 2026-09-04, and the first shift was
// NOT loud. Step 5's two query_sql scans became one
// `fmv_recalc_uncovered_editions` call and Step 5b's became
// `fmv_recalc_historical_candidates`, moving every later step down three slots
// in total. The first shift reddened four tests — but NOT the ASK_ONLY backfill
// test: its old index 1 landed on the edition_offers ASK step, which writes the
// same ASK_ONLY-at-0.90 shape, so it stayed green while testing a different code
// path entirely.
//
// ⛔ A POSITIONAL FIXTURE FAILS SILENTLY WHEN THE POSITIONS MOVE. Both steps that
// have left query_sql are now keyed by RPC NAME below, which cannot drift; only
// the ones still going through the wrapper are positional, and every one of
// those that leaves it should be renamed the same way rather than re-indexed.
// ---------------------------------------------------------------------------

const QS = (byIndex: Record<number, unknown[]>, len = 4) =>
  Array.from({ length: len }, (_, i) => ({ data: byIndex[i] ?? [], error: null }))

// The sweep RETURNS EARLY on "no editions found in window", so the fallback
// steps are only reachable when the main compute has something to chew on —
// hence a normal in-window sales set here. Assertions below filter to the
// fallback-specific edition ids so the main compute's own ed-1 row is ignored.
function fallbackFixtures(qs: ReturnType<typeof QS>) {
  return {
    sales: {
      data: [sale(10, 300, 1), sale(11, 400, 3), sale(10, 500, 6), sale(12, 600, 10), sale(10, 700, 15)],
      error: null,
    },
    editions: EDITION_META,
    edition_offers: { data: [], error: null },
    // Step 1a pages editions via this SECDEF fn (not the sales table); an empty
    // page early-returns before any fallback step can run.
    "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
    ...QUIET_TAIL,
    "rpc:query_sql": qs,
  }
}

describe("fmv-recalc 90d catch-up seed (offset 0)", () => {
  // A Top Shot edition that traded within 90d but NOT in the recent 30d is never
  // enumerated by fmv_recalc_edition_page (a 30d GROUP BY). The catch-up RPC
  // returns it, the route seeds it with EMPTY sales, and the existing 90d
  // widening fetches its 90d sales so the main loop prices it — capped at MEDIUM
  // because its true 30d count is 0. The `sales` fixture is sequence-aware:
  // call 0 = Step 1b (30d, for the enumerated ed-main), call 1 = the 90d widening
  // (for the seeded catch-up edition).
  function ninetyDayOnlySale(edition: string, price: number, serial: number, ageDays: number) {
    return { edition_id: edition, price_usd: price, sold_at: daysAgo(ageDays), serial_number: serial }
  }

  it("prices a seeded zero-30d edition off its 90d sales, gated to MEDIUM", async () => {
    const { inserted, rpcCalls } = instrument({
      pipeline_runs: { data: null, error: null }, // cursor -> offset 0
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-main" }], error: null },
      // The catch-up enumeration returns one zero-30d edition to seed.
      "rpc:fmv_recalc_90d_catchup_editions": { data: [{ edition_id: "ed-catchup-1" }], error: null },
      sales: [
        // call 0 — Step 1b (30d) for the enumerated ed-main: a normal MEDIUM set.
        { data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15), sale(10, 800, 20)].map((s) => ({ ...s, edition_id: "ed-main" })), error: null },
        // call 1 — the 90d widening for the seeded (thin) catch-up edition: six
        // sales ALL older than 30d, so 30d count is 0 but 90d count is 6.
        { data: [
          ninetyDayOnlySale("ed-catchup-1", 24, 300, 40),
          ninetyDayOnlySale("ed-catchup-1", 24, 400, 47),
          ninetyDayOnlySale("ed-catchup-1", 24, 500, 55),
          ninetyDayOnlySale("ed-catchup-1", 24, 600, 62),
          ninetyDayOnlySale("ed-catchup-1", 24, 700, 70),
          ninetyDayOnlySale("ed-catchup-1", 24, 800, 80),
        ], error: null },
      ],
      editions: {
        data: [
          { id: "ed-main", tier: "COMMON", circulation_count: 1000, external_id: "1:100", jersey_number: null },
          { id: "ed-catchup-1", tier: "COMMON", circulation_count: 1000, external_id: "1:200", jersey_number: null },
        ],
        error: null,
      },
      edition_offers: { data: [], error: null },
      allday_edition_floor_ask: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    // The catch-up RPC was called (offset 0), scoped to Top Shot.
    const catchup = rpcCalls.find((c) => c.name === "fmv_recalc_90d_catchup_editions")
    expect(catchup?.args?.p_collection_id).toBe(TOPSHOT)

    // The seeded edition is priced off its 90d sales ($24), labelled MEDIUM (its
    // true 30d count is 0, so the recency gate holds it below HIGH).
    const seeded = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-catchup-1")
    expect(seeded).toHaveLength(1)
    expect(Number(seeded[0].fmv_usd)).toBeCloseTo(24, 1)
    expect(seeded[0].confidence).toBe("MEDIUM")
    expect(seeded[0].collection_id).toBe(TOPSHOT)

    // The run still logs ok.
    expect(terminalLog(rpcCalls)).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: true })
  })

  it("enumerates BOTH Top Shot and All Day, seeding an All Day zero-30d edition off its 90d floor", async () => {
    const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
    const { inserted, rpcCalls } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-main" }], error: null },
      // Sequence-aware: call 0 = Top Shot (none this run), call 1 = All Day.
      "rpc:fmv_recalc_90d_catchup_editions": [
        { data: [], error: null },
        { data: [{ edition_id: "ed-ad-catchup" }], error: null },
      ],
      sales: [
        // call 0 — Step 1b (30d) for ed-main.
        { data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15)].map((s) => ({ ...s, edition_id: "ed-main" })), error: null },
        // call 1 — the 90d widening for the seeded All Day edition.
        { data: [
          ninetyDayOnlySale("ed-ad-catchup", 12, 300, 42),
          ninetyDayOnlySale("ed-ad-catchup", 12, 400, 50),
          ninetyDayOnlySale("ed-ad-catchup", 12, 500, 58),
          ninetyDayOnlySale("ed-ad-catchup", 12, 600, 66),
          ninetyDayOnlySale("ed-ad-catchup", 12, 700, 74),
        ], error: null },
      ],
      editions: {
        data: [
          { id: "ed-main", tier: "COMMON", circulation_count: 1000, external_id: "1:100", jersey_number: null },
          { id: "ed-ad-catchup", tier: null, circulation_count: 1000, external_id: "9001", jersey_number: null },
        ],
        error: null,
      },
      edition_offers: { data: [], error: null },
      allday_edition_floor_ask: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    // Both collections were enumerated (Top Shot first, then All Day).
    const calls = rpcCalls.filter((c) => c.name === "fmv_recalc_90d_catchup_editions")
    expect(calls).toHaveLength(2)
    expect(calls[0].args?.p_collection_id).toBe(TOPSHOT)
    expect(calls[1].args?.p_collection_id).toBe(ALLDAY)

    // The seeded All Day edition is priced off its 90d sales, tagged All Day.
    const seeded = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-ad-catchup")
    expect(seeded).toHaveLength(1)
    expect(Number(seeded[0].fmv_usd)).toBeCloseTo(12, 1)
    expect(seeded[0].confidence).toBe("MEDIUM")
    expect(seeded[0].collection_id).toBe(ALLDAY)
  })

  it("does not run the catch-up enumeration when the sweep is mid-table (offset > 0)", async () => {
    const { rpcCalls } = instrument({
      // Resume cursor puts us mid-sweep, so the once-per-sweep catch-up is skipped.
      pipeline_runs: { data: { cursor_after: "900" }, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      "rpc:fmv_recalc_90d_catchup_editions": { data: [{ edition_id: "ed-catchup-1" }], error: null },
      sales: {
        data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15)],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    expect(rpcCalls.some((c) => c.name === "fmv_recalc_90d_catchup_editions")).toBe(false)
  })

  it("tolerates a catch-up enumeration error without failing the run", async () => {
    const { rpcCalls, inserted } = instrument({
      pipeline_runs: { data: null, error: null },
      "rpc:fmv_recalc_edition_page": { data: [{ edition_id: "ed-1" }], error: null },
      "rpc:fmv_recalc_90d_catchup_editions": { data: null, error: { message: "catch-up scan timed out" } },
      sales: {
        data: [sale(10, 300, 1), sale(10, 400, 3), sale(10, 500, 6), sale(10, 600, 10), sale(10, 700, 15)],
        error: null,
      },
      editions: EDITION_META,
      edition_offers: { data: [], error: null },
      fmv_snapshots: { data: [], error: null },
      ...QUIET_TAIL,
    })

    await POST(req())
    await runDeferred()

    // The main compute still prices ed-1 and the run logs ok.
    expect((inserted.fmv_snapshots ?? []).some((r) => r.edition_id === "ed-1")).toBe(true)
    expect(terminalLog(rpcCalls)).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: true })
  })
})

describe("fmv-recalc ASK-fallback + backfill steps", () => {
  it("writes ASK_ONLY snapshots for uncovered editions with a live badge low_ask", async () => {
    // Named by RPC, not by position — see the shift note above QS.
    const { inserted, rpcCalls } = instrument({
      ...fallbackFixtures(QS({})),
      "rpc:fmv_recalc_uncovered_editions": {
        data: {
          missing_total: 3,
          candidates: [
            { edition_id: "ed-nofmv-1", collection_id: TOPSHOT, low_ask: 20 },
            { edition_id: "ed-nofmv-2", collection_id: TOPSHOT, low_ask: "13.50" },
          ],
        },
        error: null,
      },
    })
    await POST(req())
    await runDeferred()

    const rows = inserted.fmv_snapshots ?? []
    const backfilled = rows.filter((r) => String(r.edition_id).startsWith("ed-nofmv"))
    expect(backfilled).toHaveLength(2)
    // ask-derived FMV is the live ask x 0.90, labelled ASK_ONLY (not "LOW")
    expect(backfilled[0]).toMatchObject({ edition_id: "ed-nofmv-1", confidence: "ASK_ONLY" })
    expect(Number(backfilled[0].fmv_usd)).toBeCloseTo(18, 2)
    expect(Number(backfilled[1].fmv_usd)).toBeCloseTo(12.15, 2)

    const log = terminalLog(rpcCalls)
    expect(log).toMatchObject({ p_ok: true })
    // The census rides in extra now instead of a console.log nobody reads.
    expect((log?.p_extra as Record<string, unknown>)?.uncovered_census).toBe(3)
  })

  it("records a FAILED census as null, never 0, and still logs an ok run", async () => {
    // The honesty half. `?? 0` here would publish "every edition is priced" out
    // of a read that never answered; supabase-js RETURNS errors rather than
    // throwing, so nothing else would catch it. 0 and null are different claims.
    const { rpcCalls } = instrument({
      ...fallbackFixtures(QS({})),
      "rpc:fmv_recalc_uncovered_editions": {
        data: null,
        error: { message: "uncovered census blew up" },
      },
    })
    await POST(req())
    await runDeferred()

    const extra = terminalLog(rpcCalls)?.p_extra as Record<string, unknown>
    expect(extra?.uncovered_census).toBeNull()
    expect(String(extra?.backfill_error)).toContain("uncovered census blew up")
    // one failed fallback step must not fail the sweep
    expect(terminalLog(rpcCalls)).toMatchObject({ p_ok: true })
  })

  it("writes historical-fallback snapshots for editions with sales but no snapshot", async () => {
    // ⚠ The key is `latest_sold_at`, which is what the route reads. This fixture
    // said `last_sale_at` until 2026-09-04, so the route was computing
    // daysSinceSale from `new Date(undefined)` — NaN — and the case still passed
    // because it only asserted fmv_usd > 0. Naming the RPC and fixing the key
    // together, since both were ways this test could pass without exercising the
    // contract it claims.
    const { inserted } = instrument({
      ...fallbackFixtures(QS({})),
      "rpc:fmv_recalc_historical_candidates": {
        data: [
          {
            edition_id: "ed-hist-1",
            collection_id: TOPSHOT,
            avg_price: "42.00",
            min_price: "30.00",
            sales_count: 4,
            latest_sold_at: daysAgo(40),
            prev_confidence: null,
            low_ask: null,
          },
        ],
        error: null,
      },
    })
    await POST(req())
    await runDeferred()

    const hist = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-hist-1")
    expect(hist).toHaveLength(1)
    expect(Number(hist[0].fmv_usd)).toBeGreaterThan(0)
  })

  it("writes the edition_offers ASK floor for zero-sales NO_DATA editions", async () => {
    const { inserted } = instrument(
      fallbackFixtures(
        QS({ 0: [{ edition_id: "ed-ask-1", collection_id: TOPSHOT, low_ask: 50 }] }),
      ),
    )
    await POST(req())
    await runDeferred()

    const ask = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-ask-1")
    expect(ask).toHaveLength(1)
    expect(Number(ask[0].fmv_usd)).toBeCloseTo(45, 2) // 50 x 0.90
    expect(ask[0].confidence).toBe("ASK_ONLY")
  })

  it("writes the parallel (::) ASK floor for STALE/NO_DATA parallel editions", async () => {
    const { inserted } = instrument(
      fallbackFixtures(
        QS({ 1: [{ edition_id: "ed-par-1", collection_id: TOPSHOT, low_ask: "10.00" }] }),
      ),
    )
    await POST(req())
    await runDeferred()

    const par = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-par-1")
    expect(par).toHaveLength(1)
    expect(Number(par[0].fmv_usd)).toBeCloseTo(9, 2)
  })

  it("writes the All Day ASK floor from a live floor_ask", async () => {
    const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
    const { inserted } = instrument(
      fallbackFixtures(
        QS({ 2: [{ edition_id: "ed-ad-1", collection_id: ALLDAY, floor_ask: 8 }] }),
      ),
    )
    await POST(req())
    await runDeferred()

    const ad = (inserted.fmv_snapshots ?? []).filter((r) => r.edition_id === "ed-ad-1")
    expect(ad).toHaveLength(1)
    expect(Number(ad[0].fmv_usd)).toBeCloseTo(7.2, 2) // 8 x 0.90
  })

  it("tolerates a query_sql error on a fallback step without failing the run", async () => {
    const qs = QS({})
    qs[0] = { data: null, error: { message: "ask fallback query blew up" } } as never
    const { rpcCalls } = instrument(fallbackFixtures(qs))
    await POST(req())
    await runDeferred()
    // the step warns and continues; the sweep still logs an ok run
    expect(terminalLog(rpcCalls)).toMatchObject({ p_pipeline: "fmv-recalc", p_ok: true })
  })
})
