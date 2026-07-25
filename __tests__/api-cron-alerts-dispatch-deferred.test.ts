import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/alerts-dispatch's DEFERRED body — the work that runs
// inside after(), which the sibling api-cron-alerts-dispatch.test.ts stubs to a
// no-op (it only pins the auth guard + immediate 202 ack). This file captures the
// after() callback and runs it, then reads the log_pipeline_run RPC call to assert
// every classification leg the dispatcher can take:
//   - both dispatchers succeed         -> ok:true,  error:null, rows = deal+fmv
//   - a dispatcher returns { error }    -> ok:false, error prefixed "deal:"/"fmv:"
//   - a dispatcher THROWS               -> ok:false, error "... threw: <msg>"
//   - both fail                         -> both messages concatenated with "; "
//   - log_pipeline_run itself throws    -> swallowed (the callback never rejects)
// These are exactly the silent-failure paths of the alert pipeline: if the
// dispatcher errors but the run is logged ok:true (or the callback crashes before
// logging), a real missed-page never surfaces in pipeline_runs.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const dealMock = vi.hoisted(() => vi.fn())
const fmvMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/alerts", () => ({
  dispatchDueDealAlerts: dealMock,
  dispatchTriggeredFmvAlerts: fmvMock,
}))

const rpcMock = vi.hoisted(() =>
  // Rest params + `any` payload: a zero-arg vi.fn infers an empty tuple, which
  // makes `rpcMock(...a)` a spread error and `mock.calls[0]?.[1]` an index-out-of
  // -range error (TS2556 / TS2493).
  vi.fn(async (..._a: any[]): Promise<any> => ({ data: null, error: null })),
)
const sb = vi.hoisted(() => ({ rpc: (...a: any[]) => rpcMock(...a) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { POST } from "@/app/api/cron/alerts-dispatch/route"

const url = "https://t/api/cron/alerts-dispatch"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  process.env.CRON_SECRET = "cron"
  capturedAfter = null
  dealMock.mockReset()
  fmvMock.mockReset()
  rpcMock.mockReset()
  rpcMock.mockResolvedValue({ data: null, error: null })
})

// Fire the handler (immediate 202), then run the deferred after() body.
async function drive() {
  const res = await POST(makeReq({ url, auth: "Bearer tok" }))
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
  return rpcMock.mock.calls[0]?.[1] // params passed to log_pipeline_run
}

describe("/api/cron/alerts-dispatch — deferred dispatch body", () => {
  it("both dispatchers succeed → logs ok:true, error null, rows = deal+fmv", async () => {
    dealMock.mockResolvedValue({ enqueued: 3 })
    fmvMock.mockResolvedValue({ enqueued: 2 })

    const p = await drive()

    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(5)
    expect(p.p_rows_written).toBe(5)
    expect(p.p_extra.enqueued_deal).toBe(3)
    expect(p.p_extra.enqueued_fmv).toBe(2)
    expect(typeof p.p_extra.duration_ms).toBe("number")
  })

  it("deal dispatcher returns { error } → ok:false, error prefixed 'deal:', still counts fmv", async () => {
    dealMock.mockResolvedValue({ error: "deal pool timeout" })
    fmvMock.mockResolvedValue({ enqueued: 4 })

    const p = await drive()

    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("deal: deal pool timeout")
    expect(p.p_rows_found).toBe(4) // deal enqueued stays 0
    expect(p.p_extra.enqueued_deal).toBe(0)
    expect(p.p_extra.enqueued_fmv).toBe(4)
  })

  it("deal dispatcher THROWS → ok:false, error 'deal threw: <msg>'", async () => {
    dealMock.mockRejectedValue(new Error("connection reset"))
    fmvMock.mockResolvedValue({ enqueued: 1 })

    const p = await drive()

    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("deal threw: connection reset")
    expect(p.p_extra.enqueued_fmv).toBe(1)
  })

  it("fmv dispatcher returns { error } → ok:false, error prefixed 'fmv:'", async () => {
    dealMock.mockResolvedValue({ enqueued: 2 })
    fmvMock.mockResolvedValue({ error: "fmv rpc 500" })

    const p = await drive()

    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("fmv: fmv rpc 500")
    expect(p.p_rows_found).toBe(2) // deal counted, fmv 0
  })

  it("both fail (deal error + fmv throw) → both messages joined with '; '", async () => {
    dealMock.mockResolvedValue({ error: "d1" })
    fmvMock.mockRejectedValue(new Error("f2"))

    const p = await drive()

    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("deal: d1; fmv threw: f2")
    expect(p.p_rows_found).toBe(0)
  })

  it("missing enqueued fields default to 0 (nullish coalesce)", async () => {
    dealMock.mockResolvedValue({}) // no enqueued
    fmvMock.mockResolvedValue({}) // no enqueued

    const p = await drive()

    expect(p.p_ok).toBe(true)
    expect(p.p_rows_found).toBe(0)
    expect(p.p_extra.enqueued_deal).toBe(0)
    expect(p.p_extra.enqueued_fmv).toBe(0)
  })

  it("log_pipeline_run throwing is swallowed — the deferred callback never rejects", async () => {
    dealMock.mockResolvedValue({ enqueued: 1 })
    fmvMock.mockResolvedValue({ enqueued: 1 })
    rpcMock.mockRejectedValue(new Error("log write failed"))

    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    // The callback must resolve despite the logging RPC throwing (caught + console.log'd).
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
