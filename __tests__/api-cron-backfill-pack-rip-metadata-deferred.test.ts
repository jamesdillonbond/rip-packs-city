import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/backfill-pack-rip-metadata's DEFERRED after() body (the
// sibling test only pins auth + the 202 ack). This route carries an explicit
// 2026-06-11 incident comment: the backfill RPC once sat OUTSIDE the try/catch, so
// a THROW (pool timeout under saturation) rejected after() before log_pipeline_run
// and the run went silent while cron-job.org acked green. These tests pin that
// every exit path — returned {error}, thrown exception, and the success shaping of
// data.processed/value_resolved/dist_resolved into the logged envelope — reaches
// log_pipeline_run so the run can never go dark again.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

// ⓘ The `params` argument lives in the TYPE, not in the default impl. The rpc
// stub below calls `backfillImpl.fn(params)`, so the property has to accept one;
// every reassignment in this file is zero-arg, so binding it here only produced
// an unused variable — which is a ratcheted rule (`@typescript-eslint/
// no-unused-vars` has no `argsIgnorePattern` in eslint.config.mjs, so a leading
// underscore does NOT exempt it, and these two reddened `npm run lint:ratchet`
// while `npm test` and `tsc` stayed green).
const backfillImpl = vi.hoisted((): { fn: (params?: any) => Promise<any> } => ({
  fn: async () => ({ data: null, error: null }),
}))
const logImpl = vi.hoisted((): { fn: (params?: any) => Promise<any> } => ({
  fn: async () => ({ data: null, error: null }),
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  if (name === "backfill_pack_rip_metadata") return backfillImpl.fn(params)
  if (name === "log_pipeline_run") return logImpl.fn(params)
  return { data: null, error: null }
}))
const sb = vi.hoisted(() => ({ rpc: (...a: any[]) => rpc(...(a as [string, any?])) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { POST } from "@/app/api/cron/backfill-pack-rip-metadata/route"

const url = "https://t/api/cron/backfill-pack-rip-metadata"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  backfillImpl.fn = async () => ({ data: null, error: null })
  logImpl.fn = async () => ({ data: null, error: null })
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

describe("/api/cron/backfill-pack-rip-metadata — deferred body", () => {
  it("401 without the bearer, and after() is never scheduled", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  // ⚠ RE-PINNED 2026-09-20, 500 -> 2000: the PREMISE changed, the property did
  // not. What this arm holds is that the route passes a DELIBERATE drain rate
  // rather than falling through to the function default -- so the number is
  // load-bearing and a silent change to it should redden here. The new value was
  // chosen on blocks/call (534 per zero at 2000 vs 656 at 500, 96.5% cache hit at
  // both), NOT on wall time; the route carries the full measurement.
  it("the backfill RPC is called with a deliberate p_limit of 2000", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 1 }, error: null })
    await drive()
    const call = rpc.mock.calls.find((c) => c[0] === "backfill_pack_rip_metadata")
    expect(call?.[1]).toEqual({ p_limit: 2000 })
  })

  // ⚠ ADDED 2026-09-20 with the counters themselves. A count the route drops on
  // the floor is not an instrument: migration 20260920203815's zero_repair and
  // unpriced_retry legs return these three, and until this route forwarded them
  // the ONLY externally visible signal of either drain was `value_resolved`,
  // which the stale leg also moves. Both arms are asserted -- present when the
  // RPC returns them, and NULL (never 0) when it does not, because a 0 would read
  // as "the leg ran and found nothing" against an older function body.
  it("forwards the zero-repair and newly-written counters into p_extra", async () => {
    backfillImpl.fn = async () => ({
      data: {
        processed: 100, value_resolved: 40,
        zero_cleared: 5, zero_repriced: 70, value_newly_written: 75,
      },
      error: null,
    })
    await drive()
    const p = logParams()
    expect(p.p_extra.zero_cleared).toBe(5)
    expect(p.p_extra.zero_repriced).toBe(70)
    expect(p.p_extra.value_newly_written).toBe(75)
  })

  it("a function body that does not return them logs NULL, never 0", async () => {
    // The pre-20260920203815 shape. `?? 0` here would publish a clean reading of
    // something never measured -- CLAUDE.md's fabricated-value shape, in the one
    // field whose job is to report whether a repair leg is working.
    backfillImpl.fn = async () => ({
      data: { processed: 10, value_resolved: 4 },
      error: null,
    })
    await drive()
    const p = logParams()
    expect(p.p_extra.zero_cleared).toBeNull()
    expect(p.p_extra.zero_repriced).toBeNull()
    expect(p.p_extra.value_newly_written).toBeNull()
  })

  it("success → ok:true and the three dist states shape the log", async () => {
    backfillImpl.fn = async () => ({
      data: { processed: 10, value_resolved: 4, dist_newly_resolved: 3, dist_already_set: 6, dist_still_null: 1 },
      error: null,
    })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(10)
    expect(p.p_rows_written).toBe(4)
    expect(p.p_extra.value_resolved).toBe(4)
    expect(p.p_extra.dist_newly_resolved).toBe(3)
    expect(p.p_extra.dist_already_set).toBe(6)
    expect(p.p_extra.dist_still_null).toBe(1)
    expect(typeof p.p_extra.duration_ms).toBe("number")
  })

  // ⛔ THE RETIRED KEY MUST NOT COME BACK, and this is the assertion that holds
  // that. `dist_resolved` counted rows that ALREADY had a dist_id (it read
  // `RETURNING pr.dist_id IS NOT NULL` over a COALESCE-ing UPDATE), so it
  // reported 484/484/488 of 500 on three consecutive runs while `pack_rips`
  // gained nothing. ⭐ Asserting the ABSENCE of the false field, not the
  // presence of the new ones — restoring the old body reds this even if it also
  // emits the new keys alongside.
  it("SELF-TEST — the retired `dist_resolved` key is not logged, even if the RPC still returns it", async () => {
    backfillImpl.fn = async () => ({
      data: { processed: 10, value_resolved: 4, dist_resolved: 484, dist_newly_resolved: 0, dist_already_set: 9, dist_still_null: 1 },
      error: null,
    })
    await drive()
    const p = logParams()
    expect(Object.keys(p.p_extra)).not.toContain("dist_resolved")
    expect(p.p_extra.dist_newly_resolved).toBe(0)
  })

  it("returned { error } → ok:false, errMsg surfaced", async () => {
    backfillImpl.fn = async () => ({ data: null, error: { message: "backfill timeout" } })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("backfill timeout")
    expect(p.p_rows_found).toBe(0)
  })

  it("the backfill RPC THROWING is caught and STILL logged (the 2026-06-11 dark-window regression)", async () => {
    backfillImpl.fn = async () => { throw new Error("pool timeout") }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("pool timeout")
  })

  it("null RPC data coalesces every count/extra field to 0/null", async () => {
    backfillImpl.fn = async () => ({ data: null, error: null })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_rows_found).toBe(0)
    expect(p.p_rows_written).toBe(0)
    expect(p.p_extra.dist_newly_resolved).toBeNull()
    expect(p.p_extra.dist_already_set).toBeNull()
    expect(p.p_extra.dist_still_null).toBeNull()
    expect(p.p_extra.value_resolved).toBeNull()
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 2 }, error: null })
    logImpl.fn = async () => { throw new Error("log write failed") }
    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// `allday_resolved` — the All Day pricing arm's exit criterion (2026-09-12)
//
// `pull_value_usd` was structurally a TOP-SHOT-ONLY feature: it is computed from
// `moment_acquisitions.source_pack_rip_id`, which is populated on 94.8% of Top
// Shot rows and 0.0% of every other collection (no collection outside Top Shot
// has ever written an `acquisition_method = 'pack_pull'` row), and `moments`
// holds zero All Day rows so the join's second hop is empty too.
// audit_20260912_pack_rip_pull_value_allday_arm added a second source,
// `allday_pack_pull`, joined on `pack_nft_id`.
//
// ⚠ The key has to reach `pipeline_runs.extra` or the migration has no exit
// criterion: a steady `allday_resolved: 0` means the candidates never reach the
// new CTE, which is a DIFFERENT failure from "there is no All Day data" and is
// indistinguishable inside `value_resolved`, where both read as a smaller number.
describe("/api/cron/backfill-pack-rip-metadata — allday_resolved reaches the run log", () => {
  it("carries allday_resolved into pipeline_runs.extra alongside the existing counts", async () => {
    backfillImpl.fn = async () => ({
      data: {
        processed: 500,
        dist_newly_resolved: 10,
        dist_already_set: 479,
        dist_still_null: 11,
        value_resolved: 249,
        allday_resolved: 135,
      },
      error: null,
    })
    await drive()
    const p = logParams()
    expect(p.p_extra.allday_resolved).toBe(135)
    // the pre-existing keys must survive the addition
    expect(p.p_extra.value_resolved).toBe(249)
    expect(p.p_extra.dist_still_null).toBe(11)
    expect(p.p_rows_found).toBe(500)
  })

  // ⚠ NOT `?? 0`. A run whose RPC did not report the key at all (an older
  // function body, a partial failure) must log NULL — "we did not measure this"
  // — never a fabricated zero, which would read as "the All Day arm ran and
  // found nothing" and would make the exit criterion above silently unfalsifiable.
  it("logs NULL, not 0, when the RPC reports no allday_resolved at all", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 3, value_resolved: 1 }, error: null })
    await drive()
    expect(logParams().p_extra.allday_resolved).toBeNull()
  })

  // A real 0 is a measurement and must survive as 0.
  it("preserves a genuine zero", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 3, value_resolved: 1, allday_resolved: 0 }, error: null })
    await drive()
    expect(logParams().p_extra.allday_resolved).toBe(0)
  })
})
