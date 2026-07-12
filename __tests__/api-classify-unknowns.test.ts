import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/classify-unknowns. Two module-load-time
// facts drive the setup: (1) the module THROWS at import unless TS_PROXY_SECRET
// is set, and (2) auth uses a module-const INGEST_TOKEN captured at import — so
// both are set via vi.hoisted before the import runs. Auth accepts a Bearer
// header OR a ?token= query param. Fail-closed auth is the priority; the happy
// path mocks the first DB seam (moment_acquisitions select) returning an empty
// batch so no Top Shot GQL fetch is issued.

const SECRET = vi.hoisted(() => {
  process.env.TS_PROXY_SECRET = "ts-proxy-secret"
  process.env.INGEST_SECRET_TOKEN = "unknowns-secret"
  return "unknowns-secret"
})

const state: { batch: any; batchError: any } = { batch: [], batchError: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    limit: async () => ({ data: state.batch, error: state.batchError }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/classify-unknowns/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/classify-unknowns"

beforeEach(() => {
  state.batch = []
  state.batchError = null
})

describe("GET /api/classify-unknowns", () => {
  it("401s with no auth and no token", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET", auth: "Bearer wrong" }))
    expect(res.status).toBe(401)
  })

  it("returns an empty-backlog summary with a valid bearer token", async () => {
    state.batch = []
    const res = await GET(makeReq({ url: URL, method: "GET", auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ processed: 0, marketplace: 0, pack_pull: 0, unchanged: 0, remaining: 0 })
  })

  it("accepts the token via the ?token= query param", async () => {
    const res = await GET(makeReq({ url: URL, method: "GET", token: SECRET }))
    expect(res.status).toBe(200)
    expect((await res.json()).processed).toBe(0)
  })

  it("500s when the batch query errors", async () => {
    state.batchError = { message: "db down" }
    const res = await GET(makeReq({ url: URL, method: "GET", auth: `Bearer ${SECRET}` }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
