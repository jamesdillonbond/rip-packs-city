import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/run-insider-detectors' DEFERRED after() body (the
// sibling test only pins auth + the 202 ack). This route runs the insider
// detectors ONE COLLECTION AT A TIME (a deliberate invocation shape — a combined
// 3-collection RPC overran the gateway at peak and rolled back ALL alerts), then
// pulls per-detector candidate counts in parallel and logs a telemetry envelope.
// The legs worth pinning: per-collection failure isolation (one slug's RPC
// error/throw sets ok:false + joins into errMsg WITHOUT losing the others'
// committed alerts), the candidate-count null-safety (error/throw/negative →
// null, which must NOT corrupt the totals), alert extraction, and the swallowed
// log-throw.
//
// NOTE: the route reads `const TOKEN = process.env.INGEST_SECRET_TOKEN` at MODULE
// LOAD, so the token must be set in a hoisted block BEFORE the route import.
vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
})

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const runImpl = vi.hoisted(() => ({ fn: async (_p: any): Promise<any> => ({ data: {}, error: null }) }))
const countImpl = vi.hoisted(() => ({ fn: async (_p: any): Promise<any> => ({ data: 0, error: null }) }))
const logImpl = vi.hoisted(() => ({ fn: async (): Promise<any> => ({ error: null }) }))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  if (name === "run_all_insider_detectors") return runImpl.fn(params)
  if (name === "count_insider_detector_candidates") return countImpl.fn(params)
  if (name === "log_pipeline_run") return logImpl.fn()
  return { data: null, error: null }
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: (...a: any[]) => rpc(...(a as [string, any?])) } }))

import { POST, shouldCountCandidates } from "@/app/api/cron/run-insider-detectors/route"

const url = "https://t/api/cron/run-insider-detectors"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  // Candidate counts are SAMPLED (every 6th UTC hour) because they cost ~27 GB/day
  // of disk reads for pure telemetry. These legs assert the telemetry MATH, so
  // they force counting on — otherwise they would pass or fail depending on the
  // wall-clock hour the suite happened to run at, which is a flaky test, not a
  // contract. The sampling itself is pinned separately below with a fixed clock.
  process.env.INSIDER_CANDIDATE_COUNTS = "always"
  capturedAfter = null
  rpc.mockClear()
  runImpl.fn = async (_p: any) => ({ data: {}, error: null })
  countImpl.fn = async (_p: any) => ({ data: 0, error: null })
  logImpl.fn = async () => ({ error: null })
})

afterEach(() => {
  delete process.env.INSIDER_CANDIDATE_COUNTS
  vi.useRealTimers()
})

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive() {
  const res = await POST(makeReq({ url, auth: "Bearer tok" }))
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

// Build a per-slug detector result with a given unusual_volume alert count.
const slugResult = (slug: string, unusualAlerts: number) => ({
  [slug]: {
    unusual_volume: { alerts_inserted: unusualAlerts },
    floor_drops: { alerts_inserted: 0 },
    concentration_buys: { alerts_inserted: 0 },
    early_buyers: { alerts_inserted: 0 },
  },
})

describe("/api/cron/run-insider-detectors — deferred body", () => {
  // ── Candidate-count sampling ───────────────────────────────────────────────
  //
  // Measured 2026-08-13: 12 calls per hourly tick, 44.7 GB over 39.7 h at 114 MB
  // per call and 65.8% buffer hit — ~3% of ALL disk reads on the instance, spent
  // on telemetry nothing pages on. Sampled every 6th UTC hour instead.

  it("samples on the 6-hour boundary and skips otherwise", () => {
    // ⚠ Control the ENV, not the argument: `mode` defaults to
    // process.env.INSIDER_CANDIDATE_COUNTS, and a default parameter still fires
    // when you pass an explicit `undefined` — so passing undefined here reads
    // the "always" that beforeEach sets and the test asserts nothing.
    delete process.env.INSIDER_CANDIDATE_COUNTS
    for (const h of [0, 6, 12, 18]) {
      expect(shouldCountCandidates(new Date(Date.UTC(2026, 7, 13, h)), undefined)).toBe(true)
    }
    for (const h of [1, 5, 7, 11, 13, 17, 19, 23]) {
      expect(shouldCountCandidates(new Date(Date.UTC(2026, 7, 13, h)), undefined)).toBe(false)
    }
  })

  it("honours the env escape hatch in both directions", () => {
    // A diagnostic window must be openable without a deploy, and closable too.
    const offHour = new Date(Date.UTC(2026, 7, 13, 5))
    const onHour = new Date(Date.UTC(2026, 7, 13, 12))
    expect(shouldCountCandidates(offHour, "always")).toBe(true)
    expect(shouldCountCandidates(onHour, "never")).toBe(false)
  })

  it("issues ZERO count RPCs on a skipped tick, and says skipped rather than failed", async () => {
    // The saving is the point: on a non-sampling tick the 12 scans must not run.
    delete process.env.INSIDER_CANDIDATE_COUNTS
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 13, 5, 30))) // 05:30Z — not a boundary
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 0), error: null })

    await drive()

    expect(rpc.mock.calls.filter((c) => c[0] === "count_insider_detector_candidates")).toHaveLength(0)
    const p = logParams()
    const uv = p.p_extra.totals_by_detector.unusual_volume
    expect(uv.candidates_evaluated).toBeNull()
    // ⚠ The load-bearing assertion: a SKIP must never read as a failed count.
    // Before candidates_status existed, null meant "the RPC errored", so sampling
    // would have made a broken telemetry RPC invisible behind a deliberate skip.
    expect(uv.candidates_status).toBe("skipped")
    expect(p.p_extra.per_collection.nba_top_shot.floor_drops.candidates_status).toBe("skipped")
    // Detectors themselves still run on every tick — only the telemetry sampled.
    expect(rpc.mock.calls.filter((c) => c[0] === "run_all_insider_detectors")).toHaveLength(3)
  })

  it("issues the full 12 count RPCs on a sampling tick", async () => {
    delete process.env.INSIDER_CANDIDATE_COUNTS
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 13, 12, 4))) // 12:04Z — a boundary
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 0), error: null })
    countImpl.fn = async () => ({ data: 7, error: null })

    await drive()

    expect(rpc.mock.calls.filter((c) => c[0] === "count_insider_detector_candidates")).toHaveLength(12)
    const p = logParams()
    expect(p.p_extra.totals_by_detector.unusual_volume.candidates_evaluated).toBe(21) // 3 × 7
    expect(p.p_extra.totals_by_detector.unusual_volume.candidates_status).toBe("counted")
  })

  it("marks the TOTAL failed when one leg's count errors, rather than under-reporting", async () => {
    // A partial sum reads as a real, smaller number — the same shape as a
    // silently truncated ranking. Say the total is untrustworthy instead.
    let n = 0
    countImpl.fn = async () => (n++ === 0 ? { data: null, error: { message: "boom" } } : { data: 4, error: null })
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 0), error: null })

    await drive()

    const totals = logParams().p_extra.totals_by_detector
    const anyFailed = Object.values(totals).some((d: any) => d.candidates_status === "failed")
    expect(anyFailed).toBe(true)
  })

  it("401 without the bearer, after() never scheduled", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("all 3 collections succeed → ok:true, alerts + candidate totals accumulate", async () => {
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 2), error: null })
    countImpl.fn = async () => ({ data: 5, error: null })

    await drive()

    // Each of the 3 collections invoked run_all_insider_detectors individually.
    const runs = rpc.mock.calls.filter((c) => c[0] === "run_all_insider_detectors")
    expect(runs).toHaveLength(3)

    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_written).toBe(6) // 3 collections × 2 unusual alerts
    expect(p.p_extra.totals_by_detector.unusual_volume.alerts_emitted).toBe(6)
    expect(p.p_extra.totals_by_detector.unusual_volume.candidates_evaluated).toBe(15) // 3 × 5
    expect(p.p_extra.per_collection.nba_top_shot.unusual_volume.candidates_evaluated).toBe(5)
  })

  it("one collection's RPC { error } → ok:false, errMsg carries the slug, others still counted", async () => {
    runImpl.fn = async (p: any) => {
      const slug = p.p_collection_slugs[0]
      if (slug === "nfl_all_day") return { data: null, error: { message: "gateway timeout" } }
      return { data: slugResult(slug, 1), error: null }
    }
    countImpl.fn = async () => ({ data: 3, error: null })

    await drive()

    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("nfl_all_day: gateway timeout")
    expect(p.p_rows_written).toBe(2) // the 2 succeeding collections (1 each)
  })

  it("a collection RPC THROW is isolated into failed[] → ok:false", async () => {
    runImpl.fn = async (p: any) => {
      if (p.p_collection_slugs[0] === "ufc_strike") throw new Error("connection reset")
      return { data: slugResult(p.p_collection_slugs[0], 0), error: null }
    }

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toContain("ufc_strike: connection reset")
  })

  it("candidate counts that error / go negative coalesce to null without corrupting totals", async () => {
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 0), error: null })
    // error on one call, negative on another, a valid number otherwise
    let n = 0
    countImpl.fn = async () => {
      n++
      if (n === 1) return { data: null, error: { message: "count failed" } } // → null
      if (n === 2) return { data: -4, error: null } // negative → null
      return { data: 2, error: null }
    }

    await drive()

    const p = logParams()
    expect(p.p_ok).toBe(true)
    // totals only sum the numeric candidate counts; null legs are skipped, never NaN.
    const uv = p.p_extra.totals_by_detector.unusual_volume.candidates_evaluated
    expect(typeof uv).toBe("number")
    expect(Number.isNaN(uv)).toBe(false)
  })

  it("a candidate-count THROW is caught → null (does not reject the run)", async () => {
    runImpl.fn = async (p: any) => ({ data: slugResult(p.p_collection_slugs[0], 0), error: null })
    countImpl.fn = async () => { throw new Error("count threw") }

    await drive()
    expect(logParams().p_ok).toBe(true) // detector run still succeeded
  })

  it("non-object detector result yields 0 alerts (extractAlertsFromDetectorResult guard)", async () => {
    runImpl.fn = async () => ({ data: null, error: null }) // no per-slug object at all
    countImpl.fn = async () => ({ data: 1, error: null })

    await drive()
    expect(logParams().p_rows_written).toBe(0)
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    logImpl.fn = async () => { throw new Error("log write failed") }
    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
