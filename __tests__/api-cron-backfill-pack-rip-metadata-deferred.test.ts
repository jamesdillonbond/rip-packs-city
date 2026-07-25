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

const backfillImpl = vi.hoisted(() => ({ fn: async (_params?: any): Promise<any> => ({ data: null, error: null }) }))
const logImpl = vi.hoisted(() => ({ fn: async (_params?: any): Promise<any> => ({ data: null, error: null }) }))
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

  it("the backfill RPC is called with p_limit: 500", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 1 }, error: null })
    await drive()
    const call = rpc.mock.calls.find((c) => c[0] === "backfill_pack_rip_metadata")
    expect(call?.[1]).toEqual({ p_limit: 500 })
  })

  it("success → ok:true and data.{processed,value_resolved,dist_resolved} shape the log", async () => {
    backfillImpl.fn = async () => ({ data: { processed: 10, value_resolved: 4, dist_resolved: 3 }, error: null })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(10)
    expect(p.p_rows_written).toBe(4)
    expect(p.p_extra.value_resolved).toBe(4)
    expect(p.p_extra.dist_resolved).toBe(3)
    expect(typeof p.p_extra.duration_ms).toBe("number")
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
    expect(p.p_extra.dist_resolved).toBeNull()
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
