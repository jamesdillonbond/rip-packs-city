import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins the per-collection split of POST /api/admin/apply-fmv-haircut?mode=live.
//
// WHY (2026-08-16): the un-scoped call (p_collection_id NULL = every collection
// in ONE statement) failed 100% of its daily runs from at least 08-14, each at
// ~125.17s -- the global statement_timeout of 120s plus IO-throttle overshoot.
// Neither the route's maxDuration (300s) nor the RPC's own declared
// statement_timeout=300s can help: a function-level SET does not bind the
// statements inside it. So the lever is the WORK, and the fix is to give each
// collection its own budget.
//
// The properties below are the ones that make the split safe rather than merely
// faster. The most important is scope: the split must not quietly cover fewer
// collections than the single un-scoped call did.

const state = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void> | void>,
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  runs: [] as any[],
  // per-collection-id RPC outcome; null => that leg throws
  byId: {} as Record<string, { rows_examined: number; rows_haircut: number; total_dollars_removed: number } | null>,
  collections: [] as Array<{ id: string; slug: string }>,
  collectionsError: null as null | { message: string },
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void> | void) => { state.afterFns.push(fn) } }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => true,
  adminUnauthorizedResponse: () => new Response("no", { status: 401 }),
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.rpcCalls.push({ fn, args })
      if (fn === "log_pipeline_run") { state.runs.push(args); return { data: null, error: null } }
      if (fn === "fmv_apply_thin_sale_haircut") {
        const key = args.p_collection_id ?? "__all__"
        const row = state.byId[key]
        if (row === null) return { data: null, error: { message: "canceling statement due to statement timeout" } }
        return { data: [row ?? { rows_examined: 0, rows_haircut: 0, total_dollars_removed: 0 }], error: null }
      }
      return { data: null, error: null }
    },
    from: (_t: string) => ({
      select: (_c: string) => ({
        order: async () => ({ data: state.collectionsError ? null : state.collections, error: state.collectionsError }),
      }),
    }),
  },
}))

import { adminReq } from "./helpers/admin-req"
import { POST } from "@/app/api/admin/apply-fmv-haircut/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"

async function live(qs = "") {
  state.afterFns = []; state.rpcCalls = []; state.runs = []
  const res = await POST(adminReq(`https://t/api/admin/apply-fmv-haircut?mode=live${qs}`, { authorization: "Bearer x" }))
  for (const fn of state.afterFns) await fn()
  return res
}

const haircutArgs = () =>
  state.rpcCalls.filter((c) => c.fn === "fmv_apply_thin_sale_haircut").map((c) => c.args.p_collection_id)

beforeEach(() => {
  state.collectionsError = null
  state.collections = [
    { id: TS, slug: "nba_top_shot" },
    { id: AD, slug: "nfl_all_day" },
    { id: CANDY, slug: "candy_mlb" },
  ]
  state.byId = {
    [TS]: { rows_examined: 100, rows_haircut: 10, total_dollars_removed: 50 },
    [AD]: { rows_examined: 40, rows_haircut: 4, total_dollars_removed: 20 },
    [CANDY]: { rows_examined: 7, rows_haircut: 1, total_dollars_removed: 3 },
  }
})
afterEach(() => { vi.clearAllMocks() })

describe("apply-fmv-haircut per-collection split", () => {
  it("calls the RPC once per collection instead of once un-scoped", async () => {
    await live()
    // The defect this replaces: a single call with p_collection_id null.
    expect(haircutArgs()).toEqual([TS, AD, CANDY])
    expect(haircutArgs()).not.toContain(null)
  })

  it("covers candy_mlb -- the collection the hardcoded map omits", async () => {
    // THE load-bearing scope property. COLLECTION_UUID in this route lists
    // topshot/allday/golazos/ufc/pinnacle. It omits candy_mlb (which HAS live
    // fmv_snapshots rows) and includes pinnacle (which has none -- Pinnacle FMV
    // lives in pinnacle_fmv_history). Splitting on that map would have silently
    // shrunk the sweep while looking complete.
    await live()
    expect(haircutArgs()).toContain(CANDY)
  })

  it("aggregates every leg into one pipeline_runs row", async () => {
    await live()
    const run = state.runs.find((r) => r.p_pipeline === "apply-fmv-haircut")
    expect(run.p_ok).toBe(true)
    expect(run.p_rows_found).toBe(147)
    expect(run.p_rows_written).toBe(15)
    expect(run.p_extra.total_dollars_removed).toBe(73)
    expect(run.p_extra.legs_total).toBe(3)
  })

  it("keeps applying the other collections when one leg times out", async () => {
    // The whole point of the split: today one over-budget statement discards
    // all five collections. A failed leg must not roll back its siblings.
    state.byId[TS] = null
    await live()
    expect(haircutArgs()).toEqual([TS, AD, CANDY])
    const run = state.runs.find((r) => r.p_pipeline === "apply-fmv-haircut")
    expect(run.p_ok).toBe(false)
    // ...and the surviving legs' work is REPORTED, not zeroed.
    expect(run.p_rows_found).toBe(47)
    expect(run.p_rows_written).toBe(5)
    expect(run.p_extra.legs_failed).toBe(1)
    expect(run.p_error).toContain("nba_top_shot")
  })

  it("reports a partial failure as NOT ok", async () => {
    // A partial run must never read as success: the un-run collections did not
    // get their haircut, and a green row would hide that permanently.
    state.byId[CANDY] = null
    await live()
    expect(state.runs.find((r) => r.p_pipeline === "apply-fmv-haircut").p_ok).toBe(false)
  })

  it("falls back to the un-scoped call when the collections read fails", async () => {
    // A failed catalogue read must not silently narrow the sweep to nothing --
    // degrade to the old whole-table behaviour rather than skipping the run.
    state.collectionsError = { message: "timeout" }
    state.byId["__all__"] = { rows_examined: 5, rows_haircut: 1, total_dollars_removed: 2 }
    await live()
    expect(haircutArgs()).toEqual([null])
    expect(state.runs.find((r) => r.p_pipeline === "apply-fmv-haircut").p_ok).toBe(true)
  })

  it("still honours an explicit ?collection= and does not fan out", async () => {
    await live("&collection=topshot")
    expect(haircutArgs()).toEqual([TS])
  })

  it("never runs the live RPC as a dry run", async () => {
    // p_dry_run must stay false on the live path, or the cron silently stops
    // applying anything while reporting rows_haircut.
    await live()
    const calls = state.rpcCalls.filter((c) => c.fn === "fmv_apply_thin_sale_haircut")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.args.p_dry_run === false)).toBe(true)
  })
})
