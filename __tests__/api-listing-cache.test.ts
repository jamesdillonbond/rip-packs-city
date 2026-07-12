import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/listing-cache (POST).
// Auth: `if (auth !== 'Bearer '+INGEST_SECRET_TOKEN) → 401` (inside try). The
// module THROWS at import unless FLOWTY_PROXY_TOKEN is set, so we set it in a
// vi.hoisted() block that runs before the hoisted route import. We pin the 401
// guard and the Flowty kill-switch happy path (isFlowtyIngestEnabled=false →
// 200 disabled) — both pre-DB seams; the real Flowty fetch never runs.

vi.hoisted(() => {
  process.env.FLOWTY_PROXY_TOKEN = "test-flowty-token"
})

const state = { flowtyEnabled: true }

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}), rpc: async () => ({ data: null, error: null }) }),
}))
vi.mock("@/lib/flowty-flags", () => ({
  isFlowtyIngestEnabled: () => state.flowtyEnabled,
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async () => {},
}))

import { POST } from "@/app/api/listing-cache/route"

beforeEach(() => {
  state.flowtyEnabled = true
  vi.unstubAllEnvs()
})

describe("POST /api/listing-cache", () => {
  it("401s without a valid INGEST_SECRET_TOKEN Bearer header", async () => {
    const res = await POST(makeReq({ url: "https://t/api/listing-cache" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("returns 200 disabled when the Flowty ingest kill-switch is off", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    state.flowtyEnabled = false
    const res = await POST(
      makeReq({ url: "https://t/api/listing-cache", auth: "Bearer secret" })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.disabled).toBe(true)
  })
})
