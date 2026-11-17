import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/golazos-sales-indexer (POST + GET alias).
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import. We exercise BOTH
// regimes by resetting modules between them:
//   A. secret DELETED  → TOKEN === "" → every request 401s (fail-closed).
//   B. secret SET      → wrong/no token 401s, correct token reaches the 200
//      "indexing started" accept. The heavy on-chain scan is after()-deferred;
//      after() is stubbed to a no-op so the accept is observable without a
//      request scope or any chain/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({}) }))

const url = "https://t/api/golazos-sales-indexer"

describe("POST /api/golazos-sales-indexer — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/golazos-sales-indexer/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("401s fail-closed with no secret configured and no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s fail-closed even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })

  it("401s fail-closed even with a ?token= when no secret is configured", async () => {
    expect((await POST(makeReq({ url, token: "anything" }))).status).toBe(401)
  })

  it("GET alias enforces the same guard", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/golazos-sales-indexer — secret configured (success path)", () => {
  const TOKEN = "golazos-ingest-token"
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/golazos-sales-indexer/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("still 401s with no token", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200s and reports 'indexing started' with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("indexing started")
  })

  it("200s with the correct ?token= query param", async () => {
    expect((await POST(makeReq({ url, token: TOKEN }))).status).toBe(200)
  })

  it("GET delegates to POST (same auth + accept)", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
    expect((await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))).status).toBe(200)
  })
})
