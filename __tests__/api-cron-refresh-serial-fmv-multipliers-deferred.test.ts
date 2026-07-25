import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Deep drive of /api/cron/refresh-serial-fmv-multipliers' DEFERRED after() body
// (the sibling test only pins auth + the 202 ack). Captures the after() callback
// and runs it against a name-routed RPC mock to cover every classification leg of
// this FMV-adjacent weekly refresh:
//   - compute_serial_fmv_multipliers returns a number -> ok:true, rows = that number
//   - returns { error }                                -> ok:false, errMsg = error.message
//   - THROWS                                           -> ok:false, errMsg from the exception
//   - returns non-numeric data                         -> ok:true, rows stays 0
//   - log_pipeline_run throws                          -> swallowed (callback never rejects)

let capturedAfter: null | (() => Promise<void>) = null
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { capturedAfter = fn } }
})

// Per-RPC-name behavior: compute* is configured per test; log_pipeline_run
// records its params (and can be made to throw).
const computeImpl = vi.hoisted(() => ({ fn: async (): Promise<any> => ({ data: 0, error: null }) }))
const logImpl = vi.hoisted(() => ({ fn: async (): Promise<any> => ({ data: null, error: null }) }))
const rpc = vi.hoisted(() => vi.fn(async (name: string, params?: any) => {
  if (name === "compute_serial_fmv_multipliers") return computeImpl.fn()
  if (name === "log_pipeline_run") return logImpl.fn(params)
  return { data: null, error: null }
}))
const sb = vi.hoisted(() => ({ rpc: (...a: any[]) => rpc(...(a as [string, any?])) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { POST } from "@/app/api/cron/refresh-serial-fmv-multipliers/route"

const url = "https://t/api/cron/refresh-serial-fmv-multipliers"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "tok"
  capturedAfter = null
  rpc.mockClear()
  computeImpl.fn = async () => ({ data: 0, error: null })
  logImpl.fn = async (_p?: any) => ({ data: null, error: null })
})

function logParams() {
  const call = rpc.mock.calls.find((c) => c[0] === "log_pipeline_run")
  return call?.[1]
}

async function drive() {
  const res = await POST(makeReq({ url, auth: "Bearer tok" }))
  expect(res.status).toBe(202)
  expect(typeof capturedAfter).toBe("function")
  await capturedAfter!()
}

describe("/api/cron/refresh-serial-fmv-multipliers — deferred body", () => {
  it("401s without the INGEST bearer (no after scheduled)", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
    expect(capturedAfter).toBeNull()
  })

  it("compute returns a row count → ok:true, rows logged", async () => {
    computeImpl.fn = async () => ({ data: 42, error: null })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_error).toBeNull()
    expect(p.p_rows_found).toBe(42)
    expect(p.p_rows_written).toBe(42)
    expect(typeof p.p_extra.duration_ms).toBe("number")
  })

  it("compute returns { error } → ok:false, errMsg = error.message", async () => {
    computeImpl.fn = async () => ({ data: null, error: { message: "statement timeout" } })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("statement timeout")
    expect(p.p_rows_found).toBe(0)
  })

  it("compute THROWS → ok:false, errMsg from the exception", async () => {
    computeImpl.fn = async () => { throw new Error("pool exhausted") }
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(false)
    expect(p.p_error).toBe("pool exhausted")
  })

  it("compute returns non-numeric data → ok:true, rows stays 0", async () => {
    computeImpl.fn = async () => ({ data: null, error: null })
    await drive()
    const p = logParams()
    expect(p.p_ok).toBe(true)
    expect(p.p_rows_found).toBe(0)
  })

  it("log_pipeline_run throwing is swallowed — callback never rejects", async () => {
    computeImpl.fn = async () => ({ data: 7, error: null })
    logImpl.fn = async () => { throw new Error("log write failed") }
    const res = await POST(makeReq({ url, auth: "Bearer tok" }))
    expect(res.status).toBe(202)
    await expect(capturedAfter!()).resolves.toBeUndefined()
  })
})
