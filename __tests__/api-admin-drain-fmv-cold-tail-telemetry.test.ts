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
//
// EXTENDED 2026-08-18: the tick-loss half. 28 invocations produced 9 rows over
// 14h because the after() body is killed at maxDuration=60 and the terminal
// insert dies with it — a killed tick was byte-for-byte indistinguishable from
// a cron that never fired. The heartbeat + deadline-guard cases below pin the
// property that made it invisible, not the spelling of the fix.

const state = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void> | void>,
  inserted: [] as any[],
  // per-slug RPC result; a null entry simulates a hard failure on that leg
  bySlug: {} as Record<string, { processed: number } | null>,
  // per-slug simulated wall-clock cost, applied to the fake system clock
  costMs: {} as Record<string, number>,
  // when set, the RPC for this slug never settles (models a platform kill)
  hangOn: null as string | null,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void> | void) => { state.afterFns.push(fn) } }
})

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_fn: string, args: { p_collection_slug: string }) => {
      const slug = args.p_collection_slug
      if (state.hangOn === slug) return new Promise<never>(() => {})
      const cost = state.costMs[slug]
      if (cost) vi.setSystemTime(new Date(Date.now() + cost))
      const row = state.bySlug[slug]
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

const HEARTBEAT = "drain-fmv-cold-tail-heartbeat"

const heartbeats = () => state.inserted.filter((r) => r.pipeline === HEARTBEAT)
const terminals = () => state.inserted.filter((r) => r.pipeline === "drain-fmv-cold-tail")

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
  state.costMs = {}
  state.hangOn = null
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  vi.useRealTimers()
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

    expect(terminals()).toHaveLength(1)
    const row = terminals()[0]
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

    const row = terminals()[0]
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

    expect(terminals()[0].rows_found).toBe(0)
    expect(terminals()[0].rows_written).toBe(0)
    expect(terminals()[0].ok).toBe(true)
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

    expect(terminals()[0].rows_found).toBe(10)
    expect(Number.isNaN(terminals()[0].rows_found)).toBe(false)
  })

  it("scopes the count to the requested collection", async () => {
    state.bySlug = { nba_top_shot: { processed: 40 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    expect(terminals()[0].rows_found).toBe(40)
    expect(terminals()[0].extra.collection_filter).toBe("nba_top_shot")
  })

  it("keeps the per-collection breakdown in extra.results", async () => {
    // rows_found is a rollup; the stale/ask_only/no_data split is what makes a
    // confidence-label regression diagnosable, so it must not be dropped.
    state.bySlug = { nba_top_shot: { processed: 5 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    const results = terminals()[0].extra.results
    expect(Array.isArray(results)).toBe(true)
    expect(results[0].slug).toBe("nba_top_shot")
    expect(results[0].data.processed).toBe(5)
  })
})

describe("drain-fmv-cold-tail kill visibility (2026-08-18)", () => {
  it("writes the invocation heartbeat BEFORE any drain RPC runs", async () => {
    // The ordering is the whole point: a heartbeat written after the loop would
    // die with the loop, which is what the terminal insert already did.
    const seen: string[] = []
    state.bySlug = { nba_top_shot: { processed: 1 } }
    const origRpc = (await import("@/lib/supabase")).supabaseAdmin as any
    const rpc = origRpc.rpc
    origRpc.rpc = async (fn: string, args: any) => {
      seen.push(`rpc:${args.p_collection_slug}`)
      return rpc(fn, args)
    }
    try {
      state.afterFns = []
      state.inserted = []
      await POST(
        adminReq("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot", {
          authorization: "Bearer ingest",
        })
      )
      // Record the insert order by watching state.inserted grow.
      for (const fn of state.afterFns) await fn()
    } finally {
      origRpc.rpc = rpc
    }

    expect(heartbeats()).toHaveLength(1)
    // The heartbeat is the FIRST pipeline_runs write of the tick.
    expect(state.inserted[0].pipeline).toBe(HEARTBEAT)
    expect(state.inserted[0].extra.phase).toBe("started")
    expect(seen).toEqual(["rpc:nba_top_shot"])
  })

  it("leaves a heartbeat behind when the tick is killed mid-drain", async () => {
    // THE DEFECT, modelled: the after() body never completes, so the terminal
    // insert never happens. Before this change that tick wrote NOTHING and was
    // indistinguishable from a cron that never fired.
    state.bySlug = { nba_top_shot: { processed: 5 } }
    state.hangOn = "nba_top_shot"

    state.afterFns = []
    state.inserted = []
    await POST(
      adminReq("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot", {
        authorization: "Bearer ingest",
      })
    )
    // Race the never-settling body against a resolved tick: this is the kill.
    await Promise.race([Promise.all(state.afterFns.map((fn) => fn())), Promise.resolve()])
    await Promise.resolve()
    await Promise.resolve()

    expect(terminals()).toHaveLength(0)
    // ...and the invocation is STILL on the record.
    expect(heartbeats()).toHaveLength(1)
  })

  it("does not publish a fabricated zero on the heartbeat row", async () => {
    // A heartbeat measures nothing. `rows_found: 0` here would be the same
    // fabricated-measurement shape that made this pipeline read as inert in the
    // 2026-08-16 retirement sweep, so it must be explicitly null.
    state.bySlug = { nba_top_shot: { processed: 3 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    const hb = heartbeats()[0]
    expect(hb.rows_found).toBeNull()
    expect(hb.rows_written).toBeNull()
    // ok stays true so no ok=false alert fires on a marker row.
    expect(hb.ok).toBe(true)
    // finished_at pinned to started_at: duration_ms is GENERATED from the pair
    // and would otherwise publish this INSERT's own latency as a run duration.
    expect(hb.finished_at).toBe(hb.started_at)
  })
})

describe("drain-fmv-cold-tail deadline guard (2026-08-18)", () => {
  it("stops starting slugs it cannot afford, and NAMES the ones it skipped", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"))
    state.bySlug = {
      nba_top_shot: { processed: 4 },
      nfl_all_day: { processed: 4 },
      laliga_golazos: { processed: 4 },
      ufc_strike: { processed: 4 },
    }
    // Measured shape: one collection's candidate scan alone can eat 33s of the
    // 60s budget, so the second slug must not be started.
    for (const s of Object.keys(state.bySlug)) state.costMs[s] = 33_000

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    const row = terminals()[0]
    expect(row.extra.slugs_attempted).toBe(1)
    expect(row.extra.slugs_total).toBe(4)
    expect(row.extra.skipped).toHaveLength(3)
    expect(row.extra.deadline_hit).toBe(true)
    // A partial tick is not a failed tick — but it must never read as "nothing
    // left to reprice", which is what slugs_attempted/skipped are for.
    expect(row.ok).toBe(true)
    expect(row.rows_found).toBe(4)
  })

  it("still attempts every slug when they are cheap", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"))
    state.bySlug = {
      nba_top_shot: { processed: 1 },
      nfl_all_day: { processed: 1 },
      laliga_golazos: { processed: 1 },
      ufc_strike: { processed: 1 },
    }
    for (const s of Object.keys(state.bySlug)) state.costMs[s] = 2_000

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    const row = terminals()[0]
    expect(row.extra.slugs_attempted).toBe(4)
    expect(row.extra.skipped).toEqual([])
    expect(row.extra.deadline_hit).toBe(false)
    expect(row.rows_found).toBe(4)
  })

  it("always attempts at least one slug, even when the budget is already blown", async () => {
    // A guard that can skip everything punishes its own success: the tick would
    // write an honest-looking 0-row result while doing no work at all.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"))
    state.bySlug = {
      nba_top_shot: { processed: 7 },
      nfl_all_day: { processed: 7 },
      laliga_golazos: { processed: 7 },
      ufc_strike: { processed: 7 },
    }
    for (const s of Object.keys(state.bySlug)) state.costMs[s] = 120_000

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    expect(terminals()[0].extra.slugs_attempted).toBe(1)
    expect(terminals()[0].rows_found).toBe(7)
  })
})

describe("drain-fmv-cold-tail slug rotation (2026-08-18)", () => {
  const ALL = ["laliga_golazos", "nba_top_shot", "nfl_all_day", "ufc_strike"]

  it("gives every collection the first slot exactly once per 2h", async () => {
    // Without rotation the deadline guard is a starvation machine: nba_top_shot
    // is both first in the list and the most expensive, so it would be the only
    // collection ever drained while the pipeline still reported ok. Driven
    // through the route across four consecutive 30-minute ticks, not through the
    // helper, so the property survives a refactor of how the order is derived.
    vi.useFakeTimers()
    state.bySlug = Object.fromEntries(ALL.map((s2) => [s2, { processed: 1 }])) as any
    const base = Date.parse("2026-08-18T12:00:00Z")
    const firsts: string[] = []
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(base + i * 30 * 60 * 1000))
      await drain("https://t/api/admin/drain-fmv-cold-tail")
      firsts.push(terminals()[0].extra.order[0])
    }
    expect(new Set(firsts).size).toBe(4)
  })

  it("is a rotation, not a shuffle — every slug is still attempted, once", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-18T13:17:00Z"))
    state.bySlug = Object.fromEntries(ALL.map((s2) => [s2, { processed: 1 }])) as any

    await drain("https://t/api/admin/drain-fmv-cold-tail")

    const order = terminals()[0].extra.order
    expect([...order].sort()).toEqual(ALL)
    expect(terminals()[0].rows_found).toBe(4)
    // The heartbeat records the same plan the loop then followed.
    expect(heartbeats()[0].extra.order).toEqual(order)
  })

  it("is a no-op for a single-collection request", async () => {
    state.bySlug = { nba_top_shot: { processed: 2 } }

    await drain("https://t/api/admin/drain-fmv-cold-tail?collection=nba_top_shot")

    expect(terminals()[0].extra.order).toEqual(["nba_top_shot"])
  })
})
