import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/refresh-conflated-editions' DEFERRED after() body — the
// TopShot parallel-conflation + thin-FMV honesty guards (the sibling test only
// pins auth + the 202 ack). This route runs FIVE RPCs with distinct fatality:
//   remap_topshot_base_keyed_parallel_sales        (non-fatal — err/throw logged, run continues)
//   remap_topshot_parallel_to_base_misattributed   (non-fatal)
//   refresh_topshot_conflated_editions             (FATAL — err/throw sets ok:false)
//   refresh_topshot_thin_fmv_editions              (non-fatal)
//   log_pipeline_run                               (swallowed on throw)
// Getting these fatalities right matters: a conflation-refresh failure MUST red the
// run — else fake "deals" from blended parallel prices stop being suppressed with
// no signal. Captures after() and asserts the logged envelope.
//
// ── CORRECTED 2026-09-20, AND THE OLD REASON IS KEPT BECAUSE IT WAS MEASURED WRONG
// This header used to argue that "a non-fatal remap failure must NOT red the
// pipeline (which would page on a benign miss)", and the arms below pinned
// `p_ok: true` with `thin_fmv_flagged: 0` on a FAILED thin-FMV refresh.
//
// 🚨 THE PAGE IT WAS PROTECTING AGAINST CANNOT HAPPEN. `v_pipeline_failure_rates`
// — the failure alarm — is `HAVING sum(runs) >= 5` over a 2-day window, and this
// lane runs ONCE A DAY. It can never reach the floor, so `p_ok` here has never
// been able to page anything, benign or otherwise.
//
// 🚨 MEANWHILE THE COST IT TRADED FOR DID HAPPEN. Read 2026-09-20:
// `topshot_thin_fmv_editions` held 7 rows, every one stamped 09-18 01:30 PT —
// 57.9 h stale — because this route was killed at its 120 s wall on 09-19 and
// 09-20 AND pg_cron job 63, the independent daily backstop, timed out at ~604 s
// on the same two days. Four instruments could have caught it and none covers
// this lane: the failure-rate view (floor above), `pipeline_cadence_watchlist`
// (NO ROW for this pipeline), the `check_*` invariants (none names thin_fmv), and
// the pg_cron failure itself (visible only in `cron.job_run_details`).
//
// ⭐ So `p_ok` now means THE LANES WORKED, not that the body reached its end —
// CLAUDE.md's named worst sub-class. Non-fatal still means non-fatal: a thin-FMV
// failure must not stop the conflation refresh, only stop it being REPORTED as a
// success. The arms below are inverted, never deleted: each one still drives the
// same failure and now asserts the honest envelope.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

// Per-RPC-name behavior, reconfigured per test. Default: all succeed.
const impls = vi.hoisted(() => ({
  map: {} as Record<string, () => Promise<any>>,
}))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  const impl = (impls.map as any)[name]
  return impl ? impl(params) : { data: null, error: null }
}))
const sb = vi.hoisted(() => ({ rpc: (...a: any[]) => rpc(...(a as [string, any?])) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { POST } from "@/app/api/cron/refresh-conflated-editions/route"

const url = "https://t/api/cron/refresh-conflated-editions"
const ok = (data: any) => async () => ({ data, error: null })
const err = (message: string) => async () => ({ data: null, error: { message } })
const thrower = (message: string) => async () => { throw new Error(message) }

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  impls.map = {
    remap_topshot_base_keyed_parallel_sales: ok(0),
    remap_topshot_parallel_to_base_misattributed: ok(0),
    refresh_topshot_conflated_editions: ok(0),
    refresh_topshot_thin_fmv_editions: ok(0),
    log_pipeline_run: ok(null),
  }
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

describe("/api/cron/refresh-conflated-editions — deferred body", () => {
  it("all RPCs succeed → ok:true and the counts flow into p_extra", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = ok(5)
    impls.map.remap_topshot_parallel_to_base_misattributed = ok(3)
    impls.map.refresh_topshot_conflated_editions = ok(10)
    impls.map.refresh_topshot_thin_fmv_editions = ok(4)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(10) // flagged
    expect(p.p_extra.flagged_editions).toBe(10)
    expect(p.p_extra.sales_remapped).toBe(8) // 5 + 3
    expect(p.p_extra.thin_fmv_flagged).toBe(4)
  })

  it("a non-fatal remap ERROR does not STOP the run, but is no longer reported as success", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = err("remap timeout")
    impls.map.remap_topshot_parallel_to_base_misattributed = ok(2)
    impls.map.refresh_topshot_conflated_editions = ok(7)

    await drive()
    const p = logParams()
    // INVERTED 2026-09-20 (see the header). Non-fatal is about CONTINUING, which
    // the next assertion proves: the conflation refresh still ran and flagged 7.
    expect(p.p_ok).toBe(false)
    expect(p.p_extra.lanes_failed).toEqual(["remap_base_to_parallel"])
    expect(p.p_error).toMatch(/remap timeout/)
    // ⚠ The old assertion here was `sales_remapped: 2  // failed leg contributes 0`.
    // A sum over a failed leg is a PARTIAL READ published as the fact — the
    // surviving leg's 2 is real, the total is not knowable.
    expect(p.p_extra.sales_remapped).toBeNull()
    expect(p.p_extra.remap_parallel_to_base).toBe(2)
    expect(p.p_extra.remap_base_to_parallel).toBeNull()
    // The run CONTINUED past the failed lane — that is what non-fatal means.
    expect(p.p_extra.flagged_editions).toBe(7)
  })

  it("a non-fatal remap THROW does not stop the run, and is named rather than swallowed", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = thrower("connection reset")
    impls.map.refresh_topshot_conflated_editions = ok(1)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_extra.lanes_failed).toContain("remap_base_to_parallel")
    expect(p.p_extra.lane_errors.remap_base_to_parallel).toBe("connection reset")
    expect(p.p_extra.flagged_editions).toBe(1) // continued
  })

  it("the conflation refresh returning { error } is FATAL → ok:false, errMsg surfaced", async () => {
    impls.map.refresh_topshot_conflated_editions = err("refresh statement timeout")

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("refresh statement timeout")
  })

  it("the conflation refresh THROWING is caught by the outer guard → ok:false", async () => {
    impls.map.refresh_topshot_conflated_editions = thrower("deadlock detected")

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("deadlock detected")
  })

  it("🚨 a thin-FMV failure can no longer publish itself as `flagged: 0` on an ok run", async () => {
    // THE ARM THIS WHOLE CORRECTION IS ABOUT. It used to assert exactly the
    // envelope that hid a 57.9 h outage of a user-facing honesty guard:
    //   p_ok: true, thin_fmv_flagged: 0
    // which is indistinguishable from "refreshed fine, nothing was thin".
    impls.map.refresh_topshot_conflated_editions = ok(9)
    impls.map.refresh_topshot_thin_fmv_editions = err("thin fmv miss")

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    // ⚠ Asserts the ABSENCE of the false claim, not the presence of a message.
    expect(p.p_extra.thin_fmv_flagged).not.toBe(0)
    expect(p.p_extra.thin_fmv_flagged).toBeNull()
    expect(p.p_extra.lanes_failed).toEqual(["thin_fmv"])
    expect(p.p_extra.lane_errors.thin_fmv).toBe("thin fmv miss")
    expect(p.p_extra.flagged_editions).toBe(9) // the conflation refresh still ran
  })

  it("parallel→base remap error is non-fatal, and null RPC data is UNKNOWN rather than 0", async () => {
    impls.map.remap_topshot_parallel_to_base_misattributed = err("p2b timeout")
    // The old title said "null RPC data coalesces to 0" and that coalesce — `?? 0`
    // — is the fabricated-value shape CLAUDE.md bans: an unread result rendered as
    // a measured zero. `flagged` keeps its 0 because the FATAL lane owns `p_ok`
    // and reports through it; the non-fatal counters below no longer can.
    impls.map.refresh_topshot_conflated_editions = async () => ({ data: null, error: null })

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_extra.lanes_failed).toEqual(["remap_parallel_to_base"])
    expect(p.p_extra.sales_remapped).toBeNull()
  })

  it("parallel→base remap THROW is non-fatal — the run continues and names the lane", async () => {
    impls.map.remap_topshot_parallel_to_base_misattributed = thrower("p2b reset")
    impls.map.refresh_topshot_conflated_editions = ok(2)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_extra.lanes_failed).toContain("remap_parallel_to_base")
    expect(p.p_extra.flagged_editions).toBe(2) // continued
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    impls.map.refresh_topshot_conflated_editions = ok(3)
    impls.map.log_pipeline_run = thrower("log write failed")

    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})

describe("/api/cron/refresh-conflated-editions — a swallowed lane cannot report a measured zero", () => {
  // The all-green CONTROL must stay alive, or the arms above could be satisfied by
  // a route that simply always reports failure.
  it("CONTROL: every lane succeeding still gives ok:true, no lanes_failed, real counts", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = ok(5)
    impls.map.remap_topshot_parallel_to_base_misattributed = ok(3)
    impls.map.refresh_topshot_conflated_editions = ok(10)
    impls.map.refresh_topshot_thin_fmv_editions = ok(4)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_extra.lanes_failed).toEqual([])
    expect(p.p_extra.sales_remapped).toBe(8)
    expect(p.p_extra.thin_fmv_flagged).toBe(4)
  })

  it("a genuine ZERO is still reported as zero — the fix must not erase real measurements", async () => {
    // ⚠ The opposite failure mode of the one being fixed: if `null` started
    // standing in for "nothing was flagged", the guard would lose its ability to
    // say the honest thing. 0 means measured-none; null means did-not-report.
    impls.map.remap_topshot_base_keyed_parallel_sales = ok(0)
    impls.map.remap_topshot_parallel_to_base_misattributed = ok(0)
    impls.map.refresh_topshot_conflated_editions = ok(0)
    impls.map.refresh_topshot_thin_fmv_editions = ok(0)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_extra.thin_fmv_flagged).toBe(0)
    expect(p.p_extra.sales_remapped).toBe(0)
    expect(p.p_extra.lanes_failed).toEqual([])
  })

  it("an RPC returning NO row count is unknown, not zero", async () => {
    // A `RETURNS integer` handing back null used to become 0 via `?? 0`.
    impls.map.refresh_topshot_thin_fmv_editions = async () => ({ data: null, error: null })
    impls.map.refresh_topshot_conflated_editions = ok(3)

    await drive()
    const p = logParams()
    expect(p.p_extra.thin_fmv_flagged).toBeNull()
    expect(p.p_extra.lanes_failed).toEqual(["thin_fmv"])
    expect(p.p_extra.lane_errors.thin_fmv).toMatch(/no row count/)
  })

  it("every failed lane is named, and the error string carries all of them", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = err("a down")
    impls.map.remap_topshot_parallel_to_base_misattributed = thrower("b down")
    impls.map.refresh_topshot_thin_fmv_editions = err("c down")
    impls.map.refresh_topshot_conflated_editions = ok(1)

    await drive()
    const p = logParams()
    expect(p.p_extra.lanes_failed).toEqual([
      "remap_base_to_parallel",
      "remap_parallel_to_base",
      "thin_fmv",
    ])
    for (const m of ["a down", "b down", "c down"]) expect(p.p_error).toContain(m)
  })

  it("a FATAL failure keeps owning p_error — the lane summary does not displace it", async () => {
    // Precedence matters: the conflation refresh is the reason this route exists,
    // and its message must not be buried behind a non-fatal lane's.
    impls.map.refresh_topshot_conflated_editions = err("refresh statement timeout")
    impls.map.refresh_topshot_thin_fmv_editions = err("thin fmv miss")

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("refresh statement timeout")
    // ...and the swallowed lane is still recorded, just not in p_error.
    expect(p.p_extra.lanes_failed).toContain("thin_fmv")
  })
})
