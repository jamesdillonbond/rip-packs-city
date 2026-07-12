import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for POST /api/candy-sales-indexer. Bearer-gated on
// INGEST_SECRET_TOKEN (read at request time via process.env, so vi.stubEnv
// works). Priority is the fail-closed auth guard. With a valid token the route
// short-circuits to 202 "discovery_pending" because CANDY_MLB_ME_SYMBOL is still
// a TODO placeholder (candyMeSymbolReady() === false) — so the after() sweep and
// all DB writes never run. We mock @/lib/supabase only so logRun's rpc call is inert.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))

import { POST } from "@/app/api/candy-sales-indexer/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/candy-sales-indexer"

beforeEach(() => {
  vi.stubEnv("INGEST_SECRET_TOKEN", "candy-secret")
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/candy-sales-indexer", () => {
  it("401s with no Authorization header", async () => {
    const res = await POST(makeReq({ url: URL }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("401s when INGEST_SECRET_TOKEN is unset (fail-closed on empty secret)", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    const res = await POST(makeReq({ url: URL, auth: "Bearer candy-secret" }))
    expect(res.status).toBe(401)
  })

  it("202s (discovery_pending) with a valid token while the ME symbol is a TODO placeholder", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer candy-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skipped).toBe("discovery_pending")
  })
})
