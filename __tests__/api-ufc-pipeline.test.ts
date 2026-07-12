import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/ufc-pipeline. A cron trigger that chains
// ufc-listing-cache → ufc-sales-indexer. Auth: Bearer INGEST_SECRET_TOKEN OR
// ?token=, captured into a module-level `TOKEN = process.env.INGEST_SECRET_TOKEN
// ?? ""` at import. Two regimes via vi.resetModules():
//   A. secret DELETED → TOKEN === "" → fail-closed 401.
//   B. secret SET      → wrong/no token 401s, correct bearer/?token reaches the
//      200 { ok:true, message:"UFC pipeline triggered" } accept. The two chained
//      fetches run inside after() (stubbed no-op), so no network is touched.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

const url = "https://t/api/ufc-pipeline"
const savedIngest = process.env.INGEST_SECRET_TOKEN
afterAll(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("GET /api/ufc-pipeline — no secret configured (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/ufc-pipeline/route")
    GET = mod.GET as any
  })

  it("401s without a token", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
  it("401s even with a ?token= when no secret is configured", async () => {
    expect((await GET(makeReq({ url, method: "GET", token: "x" }))).status).toBe(401)
  })
})

describe("GET /api/ufc-pipeline — secret configured (success path)", () => {
  const TOKEN = "ufc-pipeline-token"
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/ufc-pipeline/route")
    GET = mod.GET as any
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200-accepts with the correct bearer token (chain deferred)", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("UFC pipeline triggered")
    expect(typeof body.triggeredAt).toBe("string")
  })

  it("200-accepts with the correct ?token= query param", async () => {
    expect((await GET(makeReq({ url, method: "GET", token: TOKEN }))).status).toBe(200)
  })
})
