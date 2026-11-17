import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/allday-listings-retry (resolution-retry cron).
// Auth: STRICT Bearer INGEST_SECRET_TOKEN into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` (`auth !== "Bearer TOKEN"` →
// 401) — unlike the indexers this route does NOT honour ?token=. Two regimes via
// resetModules:
//   A. no secret → TOKEN "" → every request 401s (fail-closed).
//   B. secret set → wrong/no token AND ?token= 401; only the correct bearer
//      reaches the 200 "retry queued" accept. The failure-queue drain + Flow REST
//      Cadence fallback runs inside after() (stubbed no-op), so the accept is
//      observable without any chain/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const url = "https://t/api/allday-listings-retry"

describe("POST /api/allday-listings-retry — no secret configured (fail-closed)", () => {
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/allday-listings-retry/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("POST 401s with no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("POST 401s even with a bearer token when no secret is configured", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer anything" }))).status).toBe(401)
  })
  it("GET alias enforces the same guard", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/allday-listings-retry — secret configured (success path)", () => {
  const TOKEN = "allday-retry-token"
  let POST: (req: any) => Promise<Response>
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/allday-listings-retry/route")
    POST = mod.POST as any
    GET = mod.GET as any
  })

  it("still 401s with no / wrong token", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
    expect((await POST(makeReq({ url, auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("401s with a ?token= query param (strict bearer only — ?token= does not authorize)", async () => {
    expect((await POST(makeReq({ url, token: TOKEN }))).status).toBe(401)
  })

  it("200s and reports 'retry queued' with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("retry queued")
  })

  it("GET delegates to POST (same strict-bearer auth + accept)", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
    expect((await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))).status).toBe(200)
  })
})
