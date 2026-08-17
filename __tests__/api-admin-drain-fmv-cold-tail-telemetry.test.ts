import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { adminReq } from "./helpers/admin-req"

// Drives the after() body of POST /api/admin/drain-fmv-cold-tail and pins the
// pipeline_runs telemetry, which the sibling suite cannot see because it stubs
// `after` to a no-op.
//
// WHY THIS EXISTS (2026-08-16): the insert previously OMITTED rows_found and
// rows_written, so they defaulted to 0 on EVERY run while the drain was really
// repricing 5-71 editions a tick. That made a live FMV WRITER — it inserts
// algo_version 'cold-tail-1.0' snapshots whose confidence labels feed the
// roadmap's headline HIGH/MEDIUM-share metric — indistinguishable from an inert
// pipeline in `pipeline_runs_daily` and in any sweep for zero-output crons. A
// sweep for retirable schedules flagged it as waste on exactly that signal.
//
// The mapping is a MEASUREMENT, not an estimate: every branch of
// drain_fmv_cold_tail's loop does exactly one INSERT INTO fmv_snapshots
// (with_sales / ask_only / stale / no_data) before incrementing v_processed, so
// processed == rows inserted. Both columns therefore carry the same number.

const state = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void> | void>,
  inserted: [] as any[],
  // per-slug RPC result; a null entry simulates a hard failure on that leg
  bySlug: {} as Record<string, { processed: number } | null>,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void> | void) => { state.afterFns.push(fn) } }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_fn: string, args: { p_collection_slug: string }) => {
      const row = state.bySlug[args.p_collection_slug]
      if (row === null) return { data: null, error: { message: "pool timeout" } }
      return { data: row ?? { processed: 0 }, error: null }
    },
    from: (table: string) => ({
      insert: async (row: any) => {
        if (table === "pipeline_runs") state.inserted.push(row)
        return { error: null }
      },
    }),
  },
}))

import { POST } from "@/app/api/admin/drain-fmv-cold-tail/route"

async function drain(url: string) {
  state.afterFns = []
  state.inserted = []
  const res = await POST(adminReq(url, { authorization: "Bearer ingest" }))
  for (const fn of state.afterFns) await fn()
  return res
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  state.bySlug = {}
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("drain-fmv-cold-tail telemetry", () => {
  it("reports rows_found and rows_written as the summed processed count, not 0", async () => {
    state.bySlug = {
      nba_top_shot: { processed: 63 },
      nfl_all_day: { processed: 8 },
      laliga_golazos: { processed: 0 },
      ufc_strike: { processed: 0 },
    }

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    expect(state.inserted).toHaveLength(1)
    const row = state.inserted[0]
    expect(row.pipeline).toBe("drain-fmv-cold-tail")
    // The defect this pins: these were absent, so both read 0 on a 71-edition run.
    expect(row.rows_found).toBe(71)
    expect(row.rows_written).toBe(71)
    expect(row.ok).toBe(true)
  })

  it("counts a failed leg as 0 rather than NaN, and still writes the row", async () => {
    // A hard RPC failure leaves data null; the route must not propagate that
    // into arithmetic. The run is not ok, but it MUST still produce a row --
    // the route's own comment requires a row even when a slug fails hard.
    state.bySlug = {
      nba_top_shot: { processed: 12 },
      nfl_all_day: null,
      laliga_golazos: { processed: 3 },
      ufc_strike: { processed: 0 },
    }

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    const row = state.inserted[0]
    expect(row.rows_found).toBe(15)
    expect(Number.isNaN(row.rows_found)).toBe(false)
    expect(row.ok).toBe(false)
  })

  it("reports 0 honestly when there is genuinely nothing to reprice", async () => {
    // A real steady state for this drain -- an all-zero tick must stay 0, so
    // the fix cannot be 'always report something'.
    state.bySlug = {
      nba_top_shot: { processed: 0 },
      nfl_all_day: { processed: 0 },
      laliga_golazos: { processed: 0 },
      ufc_strike: { processed: 0 },
    }

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    expect(state.inserted[0].rows_found).toBe(0)
    expect(state.inserted[0].rows_written).toBe(0)
    expect(state.inserted[0].ok).toBe(true)
  })

  it("treats a payload with no processed key as 0, not NaN", async () => {
    // Genuinely reachable, not contrived: drain_fmv_cold_tail's 'unknown
    // collection' guard returns {error, collection_slug} with NO processed key
    // and NO rpc error -- so this leg reports ok while carrying no count.
    state.bySlug = {
      nba_top_shot: { processed: 9 },
      // @ts-expect-error deliberately modelling the key-less payload
      nfl_all_day: { error: "unknown collection", collection_slug: "nfl_all_day" },
      laliga_golazos: { processed: 1 },
      ufc_strike: { processed: 0 },
    }

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    expect(state.inserted[0].rows_found).toBe(10)
    expect(Number.isNaN(state.inserted[0].rows_found)).toBe(false)
  })

  it("scopes the count to the requested collection", async () => {
    state.bySlug = { nba_top_shot: { processed: 40 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    expect(state.inserted[0].rows_found).toBe(40)
    expect(state.inserted[0].extra.collection_filter).toBe("nba_top_shot")
  })

  it("keeps the per-collection breakdown in extra.results", async () => {
    // rows_found is a rollup; the stale/ask_only/no_data split is what makes a
    // confidence-label regression diagnosable, so it must not be dropped.
    state.bySlug = { nba_top_shot: { processed: 5 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    const results = state.inserted[0].extra.results
    expect(Array.isArray(results)).toBe(true)
    expect(results[0].slug).toBe("nba_top_shot")
    expect(results[0].data.processed).toBe(5)
  })
})
