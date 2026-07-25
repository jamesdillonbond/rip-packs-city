import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/refresh-pack-grail-metrics-mv's DEFERRED after() body
// (the sibling test only pins auth + the 202 ack). Same documented 2026-06-11
// incident class as backfill-pack-rip-metadata: the REFRESH MATERIALIZED VIEW
// CONCURRENTLY RPC once threw (timing out under saturation) before
// log_pipeline_run, so the run went silent while cron-job.org acked green. Pin
// that the returned-error AND thrown-exception legs both reach the logger.

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

const refreshImpl = vi.hoisted(() => ({ fn: async (_params?: any): Promise<any> => ({ data: null, error: null }) }))
const logImpl = vi.hoisted(() => ({ fn: async (_params?: any): Promise<any> => ({ data: null, error: null }) }))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  if (name === "refresh_pack_grail_metrics_mv") return refreshImpl.fn()
  if (name === "log_pipeline_run") return logImpl.fn(params)
  return { data: null, error: null }
}))
const sb = vi.hoisted(() => ({ rpc: (...a: any[]) => rpc(...(a as [string, any?])) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { POST, GET } from "@/app/api/cron/refresh-pack-grail-metrics-mv/route"

const url = "https://t/api/cron/refresh-pack-grail-metrics-mv"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  refreshImpl.fn = async () => ({ data: null, error: null })
  logImpl.fn = async () => ({ data: null, error: null })
})

function logParams() {
  return rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")?.[1]
}
async function drive(handler = POST) {
  const res = await handler(makeReq({ url, auth: "Bearer tok" }))
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

describe("/api/cron/refresh-pack-grail-metrics-mv — deferred body", () => {
  it("401 without the bearer, and after() is never scheduled", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("refresh succeeds → ok:true, error null", async () => {
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(typeof p.p_extra.duration_ms).toBe("number")
  })

  it("returned { error } → ok:false, errMsg surfaced", async () => {
    refreshImpl.fn = async () => ({ data: null, error: { message: "concurrently blocked" } })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("concurrently blocked")
  })

  it("the refresh RPC THROWING is caught and STILL logged (the 2026-06-11 dark-window regression)", async () => {
    refreshImpl.fn = async () => { throw new Error("refresh timeout") }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("refresh timeout")
  })

  it("GET alias drives the same deferred body", async () => {
    refreshImpl.fn = async () => ({ data: null, error: { message: "via GET" } })
    await drive(GET)
    expect(logParams().p_error).toBe("via GET")
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    logImpl.fn = async () => { throw new Error("log write failed") }
    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
