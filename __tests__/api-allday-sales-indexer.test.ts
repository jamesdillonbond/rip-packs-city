import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/allday-sales-indexer (POST + GET delegates).
// Bearer INGEST_SECRET_TOKEN OR ?token=, captured at import into
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""`. Two regimes via resetModules:
//   A. no secret → TOKEN "" → all requests 401 (fail-closed).
//   B. secret set → wrong/no token 401; correct token reaches the 200 "indexing
//      started" accept. The V1/V2 triple-storefront scan runs inside after()
//      (stubbed no-op), so the accept is observable without chain/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({}) }))
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateAllDayEditions: async () => [],
  toUpsertRow: () => ({}),
}))

const url = "https://t/api/allday-sales-indexer"

describe("POST /api/allday-sales-indexer — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/allday-sales-indexer/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("POST 401s with no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("POST 401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })
  it("GET 401s with no token", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/allday-sales-indexer — secret configured (success path)", () => {
  const TOKEN = "allday-ingest-token"
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/allday-sales-indexer/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("still 401s with no / wrong token", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
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

  it("GET delegates to POST", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))).status).toBe(200)
  })
})
