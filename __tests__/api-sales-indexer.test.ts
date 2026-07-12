import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/sales-indexer (POST + GET-delegates-to-POST).
// Auth is Bearer INGEST_SECRET_TOKEN OR ?token=, read into a module-level TOKEN
// at IMPORT time, so the env must be set BEFORE importing the route. The heavy
// chain scan + ingest runs inside after() — stubbed to a no-op so the immediate
// 202 is observable without a request scope and without touching FCL/Supabase.
// Fail-closed: no/wrong token → 401; correct token → 202 accepted.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/flow", () => ({ default: { send: async () => ({}), decode: async () => ({}), getBlock: () => ({}), getEventsAtBlockHeightRange: () => ({}) } }))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/chains/flow/dapper-v1-tx-decode", () => ({ decodeTopShotSaleTx: async () => ({}) }))
vi.mock("@sentry/nextjs", () => ({ withScope: () => {}, captureException: () => {} }))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { POST, GET } = await import("@/app/api/sales-indexer/route")

function req(auth?: string, token?: string) {
  const url = new URL("https://t/api/sales-indexer" + (token ? `?token=${token}` : ""))
  return {
    nextUrl: url,
    headers: new Headers(auth ? { authorization: auth } : {}),
  } as any
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/sales-indexer", () => {
  it("401s with no authorization header or token", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong"))).status).toBe(401)
  })

  it("202s with the correct bearer token", async () => {
    const res = await POST(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(202)
    expect((await res.json()).status).toBe("accepted")
  })

  it("202s with the correct ?token= query param", async () => {
    const res = await POST(req(undefined, TOKEN))
    expect(res.status).toBe(202)
  })

  it("GET delegates to POST (same auth guard)", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req(`Bearer ${TOKEN}`))).status).toBe(202)
    expect(typeof GET).toBe("function")
  })
})
