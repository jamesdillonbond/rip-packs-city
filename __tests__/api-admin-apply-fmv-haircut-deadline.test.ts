import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Pins the two things that turn a SILENT kill of POST /api/admin/apply-fmv-haircut
// into a LOGGED one.
//
// WHY (2026-09-13): the 2026-09-12 15:35 PT tick was killed at the 300 s wall
// under DB saturation. Vercel logged `Task timed out after 300 seconds`;
// pipeline_runs recorded NOTHING (try/catch cannot catch a maxDuration kill);
// the only instrument that noticed was the 30 h silence arm, a day later. The
// mechanism is the per-collection leg loop: each leg can hold ~120 s before the
// Supabase gateway gives up, and two such legs plus the small ones pass the wall
// before the terminal write runs.
//
//   1. An invocation heartbeat lands BEFORE any haircut RPC, under the separate
//      `-heartbeat` name, so the kill-correlation query can see a killed tick.
//   2. A leg is not STARTED once the elapsed time passes LEG_START_DEADLINE_MS;
//      the run then terminates with ok=false and the skipped legs NAMED, instead
//      of dying at the wall with no row at all.
//
// ⚠ The deadline test drives a FAKE clock through Date.now and advances it
// INSIDE the RPC mock, so "a leg that took 200 s" is simulated without waiting.
// The assertion is on the terminal row's shape, which is what a reader of
// pipeline_runs sees — not on any timer.

const state = vi.hoisted(() => ({
  afterFns: [] as Array<() => Promise<void> | void>,
  calls: [] as string[], // ordered trace: "hb" | "rpc:<collection>" | "log"
  runs: [] as any[],
  heartbeats: [] as any[],
  legMs: {} as Record<string, number>, // how long each collection's RPC "takes"
  collections: [] as Array<{ id: string; slug: string }>,
  nowMs: 1_000_000,
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
      if (fn === "log_pipeline_run") { state.calls.push("log"); state.runs.push(args); return { data: null, error: null } }
      if (fn === "fmv_apply_thin_sale_haircut") {
        const key = args.p_collection_id ?? "__all__"
        state.calls.push(`rpc:${key}`)
        state.nowMs += state.legMs[key] ?? 1_000
        return { data: [{ rows_examined: 3, rows_haircut: 1, total_dollars_removed: 2.5 }], error: null }
      }
      return { data: null, error: null }
    },
    from: (table: string) => ({
      select: () => ({
        order: async () => ({ data: state.collections, error: null }),
      }),
      insert: async (row: any) => {
        if (table === "pipeline_runs") { state.calls.push("hb"); state.heartbeats.push(row) }
        return { error: null }
      },
    }),
  },
}))

import { adminReq } from "./helpers/admin-req"
import { POST, maxDuration } from "@/app/api/admin/apply-fmv-haircut/route"

// Re-derived here, not imported: a Next.js route module may only export route
// fields. The route's own derivation is wall − one gateway-bound leg − the
// terminal-write reserve; if that changes, the skipped-leg error text below
// (which names the live value) stops matching and this test says so.
const LEG_START_DEADLINE_MS = maxDuration * 1000 - 120_000 - 30_000

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const AD = "dee28451-5d62-409e-a1ad-a83f763ac070"
const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"

async function live() {
  state.afterFns = []; state.calls = []; state.runs = []; state.heartbeats = []
  const res = await POST(adminReq(`https://t/api/admin/apply-fmv-haircut?mode=live`, { authorization: "Bearer x" }))
  for (const fn of state.afterFns) await fn()
  return res
}

beforeEach(() => {
  state.nowMs = 1_000_000
  vi.spyOn(Date, "now").mockImplementation(() => state.nowMs)
  state.collections = [
    { id: CANDY, slug: "candy_mlb" },
    { id: TS, slug: "nba_top_shot" },
    { id: AD, slug: "nfl_all_day" },
  ]
  state.legMs = {}
})
afterEach(() => { vi.restoreAllMocks() })

describe("apply-fmv-haircut — a kill at the wall is logged, not silent", () => {
  it("writes the invocation heartbeat BEFORE the first haircut RPC, under the -heartbeat name", async () => {
    await live()
    expect(state.calls[0]).toBe("hb")
    expect(state.calls.filter((c) => c === "hb")).toHaveLength(1)
    expect(state.heartbeats[0].pipeline).toBe("apply-fmv-haircut-heartbeat")
    // NULL counters — a marker measures nothing (the `?? 0` shape is banned).
    expect(state.heartbeats[0].rows_found).toBeNull()
    expect(state.heartbeats[0].rows_written).toBeNull()
    // The terminal row's started_at equals the marker's, so kill-correlation
    // (±5 s) matches them.
    expect(state.runs[0].p_started_at).toBe(state.heartbeats[0].started_at)
  })

  it("derives the leg-start deadline from the wall, leaving room for one gateway-bound leg plus the terminal write", async () => {
    state.legMs = { [CANDY]: LEG_START_DEADLINE_MS + 1 }
    await live()
    // The route names its live deadline in the skipped leg's error, so the
    // derivation is asserted against the route, not against this file.
    expect(state.runs[0].p_error).toContain(`${LEG_START_DEADLINE_MS} ms leg-start deadline (wall ${maxDuration * 1000} ms)`)
    expect(LEG_START_DEADLINE_MS).toBeGreaterThan(0)
  })

  it("runs every leg when the clock stays inside the deadline", async () => {
    await live()
    expect(state.calls.filter((c) => c.startsWith("rpc:"))).toEqual([`rpc:${CANDY}`, `rpc:${TS}`, `rpc:${AD}`])
    expect(state.runs[0].p_ok).toBe(true)
    expect(state.runs[0].p_extra.legs_skipped).toBe(0)
  })

  it("does NOT start a leg past the deadline: the run terminates ok=false with the skipped legs NAMED", async () => {
    // Two gateway-bound legs (~120 s each, the measured saturation shape) —
    // the third would have started at ~240 s and died at the 300 s wall.
    state.legMs = { [CANDY]: 121_000, [TS]: 121_000 }
    await live()

    const rpcs = state.calls.filter((c) => c.startsWith("rpc:"))
    expect(rpcs).toEqual([`rpc:${CANDY}`, `rpc:${TS}`])
    expect(rpcs).not.toContain(`rpc:${AD}`)

    // The terminal row LANDED — that is the whole point — and it is honest:
    expect(state.calls[state.calls.length - 1]).toBe("log")
    const run = state.runs[0]
    expect(run.p_ok).toBe(false)
    expect(run.p_error).toContain("nfl_all_day")
    expect(run.p_error).toContain("skipped")
    expect(run.p_extra.legs_skipped).toBe(1)
    expect(run.p_extra.legs_failed).toBe(1)
    expect(run.p_extra.legs_total).toBe(3)
    const skipped = run.p_extra.legs.find((l: any) => l.slug === "nfl_all_day")
    expect(skipped.skipped).toBe(true)
    expect(skipped.ok).toBe(false)
    // The legs that DID run still report their work — a partial failure must
    // not read as zero (the drain-fmv-cold-tail lesson).
    expect(run.p_rows_found).toBe(6)
    expect(run.p_rows_written).toBe(2)
  })

  it("is the wall, not the leg count, that trips it — a single slow leg followed by cheap ones still terminates", async () => {
    state.legMs = { [CANDY]: LEG_START_DEADLINE_MS + 1 }
    await live()
    expect(state.calls.filter((c) => c.startsWith("rpc:"))).toEqual([`rpc:${CANDY}`])
    expect(state.runs[0].p_ok).toBe(false)
    expect(state.runs[0].p_extra.legs_skipped).toBe(2)
  })
})
