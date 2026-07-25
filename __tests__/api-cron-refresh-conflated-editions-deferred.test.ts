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
// Getting these fatalities right matters: a non-fatal remap failure must NOT red
// the pipeline (which would page on a benign miss), while a conflation-refresh
// failure MUST — else fake "deals" from blended parallel prices stop being
// suppressed with no signal. Captures after() and asserts the logged envelope.

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

  it("a non-fatal remap ERROR does not red the run (ok stays true)", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = err("remap timeout")
    impls.map.remap_topshot_parallel_to_base_misattributed = ok(2)
    impls.map.refresh_topshot_conflated_editions = ok(7)

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_extra.sales_remapped).toBe(2) // failed leg contributes 0
    expect(p.p_extra.flagged_editions).toBe(7)
  })

  it("a non-fatal remap THROW does not red the run", async () => {
    impls.map.remap_topshot_base_keyed_parallel_sales = thrower("connection reset")
    impls.map.refresh_topshot_conflated_editions = ok(1)

    await drive()
    expect(logParams().p_ok).toBe(true)
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

  it("a non-fatal thin-FMV failure does not red an otherwise-green run", async () => {
    impls.map.refresh_topshot_conflated_editions = ok(9)
    impls.map.refresh_topshot_thin_fmv_editions = err("thin fmv miss")

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_extra.thin_fmv_flagged).toBe(0)
    expect(p.p_extra.flagged_editions).toBe(9)
  })

  it("parallel→base remap error/throw are also non-fatal, and null RPC data coalesces to 0", async () => {
    impls.map.remap_topshot_parallel_to_base_misattributed = err("p2b timeout")
    impls.map.refresh_topshot_conflated_editions = async () => ({ data: null, error: null }) // null → 0

    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_extra.flagged_editions).toBe(0)
    expect(p.p_extra.sales_remapped).toBe(0)
  })

  it("parallel→base remap THROW is non-fatal", async () => {
    impls.map.remap_topshot_parallel_to_base_misattributed = thrower("p2b reset")
    impls.map.refresh_topshot_conflated_editions = ok(2)

    await drive()
    expect(logParams().p_ok).toBe(true)
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    impls.map.refresh_topshot_conflated_editions = ok(3)
    impls.map.log_pipeline_run = thrower("log write failed")

    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
