import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/classify-acquisitions. Bearer-gated on
// INGEST_SECRET_TOKEN (captured into a module-level const at import time, so we
// set it via vi.hoisted before the import). Fail-closed auth is the priority;
// the one happy path mocks the sole seam — supabaseAdmin.functions.invoke of the
// edge function — plus the log_pipeline_run rpc.

const SECRET = vi.hoisted(() => {
  process.env.INGEST_SECRET_TOKEN = "classify-secret"
  return "classify-secret"
})

const state: { invokeData: any; invokeError: any } = { invokeData: null, invokeError: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    functions: { invoke: async () => ({ data: state.invokeData, error: state.invokeError }) },
    rpc: async () => ({ data: null, error: null }),
  },
}))

import { POST } from "@/app/api/classify-acquisitions/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/classify-acquisitions"

beforeEach(() => {
  state.invokeData = { scanned: 10, classified: 4, skipped: 6 }
  state.invokeError = null
})

describe("POST /api/classify-acquisitions", () => {
  it("401s with no Authorization header", async () => {
    const res = await POST(makeReq({ url: URL }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer wrong" }))
    expect(res.status).toBe(401)
  })

  it("invokes the edge function and returns its result for a valid token", async () => {
    const res = await POST(makeReq({ url: URL, auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.result).toEqual({ scanned: 10, classified: 4, skipped: 6 })
  })

  it("500s when the edge function invoke errors", async () => {
    state.invokeData = null
    state.invokeError = { message: "edge boom" }
    const res = await POST(makeReq({ url: URL, auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("edge boom")
  })
})
