import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"

// Route-integration test for /api/cron/purge-stale-listings.
// Auth: Bearer INGEST_SECRET_TOKEN (guard active only when the token env is set)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: GET runs SYNCHRONOUSLY — it awaits
// from("cached_listings").delete().lt(...).select("id") and returns 200
// { ok:true, deletedCount: data.length }. The chainable stub resolves to a
// fixture list of deleted ids so deletedCount is fixture-derived.

// Route imports supabaseAdmin from "@/lib/supabase"; stub a self-referential,
// thenable delete-chain that resolves to the deleted-id fixture.
const state: { result: any; throwErr: any; rpcError: any } = {
  result: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
  throwErr: null,
  rpcError: null,
}
const sbChain: any = {
  from: () => sbChain,
  delete: () => sbChain,
  lt: () => sbChain,
  select: () => sbChain,
  then: (resolve: any, reject: any) =>
    state.throwErr ? reject(state.throwErr) : resolve(state.result),
}
vi.mock("@/lib/supabase", () => ({
  // rpc backs log_pipeline_run — present so the happy path exercises the real
  // logRun success branch rather than its defensive catch.
  supabaseAdmin: { from: () => sbChain, rpc: async () => ({ error: state.rpcError }) },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/purge-stale-listings/route")
})

beforeEach(() => {
  state.result = { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }
  state.throwErr = null
  state.rpcError = null
})

describe("GET /api/cron/purge-stale-listings", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/purge-stale-listings — success path (synchronous delete count)", () => {
  it("200s with ok and deletedCount from the deleted-id fixture length", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.deletedCount).toBe(3)
  })

  it("POST reaches the same 200 accept when authed", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deletedCount).toBe(3)
  })
})

describe("GET /api/cron/purge-stale-listings — failure paths (silent-run guard)", () => {
  it("500s and logs ok:false on a delete error", async () => {
    state.result = { data: null, error: { message: "delete blocked" } }
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe("delete blocked")
  })

  it("500s on a fatal throw during the delete", async () => {
    state.throwErr = new Error("connection reset")
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("connection reset")
  })

  it("still 200s when the delete succeeds but log_pipeline_run itself errors (non-fatal)", async () => {
    state.rpcError = { message: "log rpc down" }
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("flags count_capped semantics via a 1000-row deletion (reported count saturates, delete is unbounded)", async () => {
    state.result = { data: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })), error: null }
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deletedCount).toBe(1000)
  })
})
