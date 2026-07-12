import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/ufc-listing-cache (GET only export).
// Auth: Bearer INGEST_SECRET_TOKEN or ?token= into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` (`!TOKEN || (bearer!==TOKEN &&
// urlToken!==TOKEN)` → 401). Unlike the other listing caches this route hits
// api2.flowty.io directly, so it does NOT require FLOWTY_PROXY_TOKEN at import.
// Two regimes via resetModules:
//   A. no secret → TOKEN "" → every request 401s (fail-closed).
//   B. secret set → wrong/no token 401; correct token reaches the 200 accept
//      ({status:"accepted"}). GET defers the paginated Flowty fetch/upsert to
//      after() (stubbed no-op), so the accept is observable with no Flowty/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const url = "https://t/api/ufc-listing-cache"

describe("GET /api/ufc-listing-cache — no secret configured (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    const mod = await import("@/app/api/ufc-listing-cache/route")
    GET = mod.GET as any
  })

  it("401s without a token", async () => {
    const res = await GET(makeReq({ url, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("401s with a bogus ?token=", async () => {
    expect((await GET(makeReq({ url, method: "GET", token: "x" }))).status).toBe(401)
  })
})

describe("GET /api/ufc-listing-cache — secret configured (accept path)", () => {
  const TOKEN = "ufc-listing-cache-token"
  let GET: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    const mod = await import("@/app/api/ufc-listing-cache/route")
    GET = mod.GET as any
  })

  it("still 401s with a wrong bearer token", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("200s and reports the background-accept with the correct bearer token", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("accepted")
    expect(body.message).toContain("ufc-listing-cache")
  })

  it("200s with the correct ?token= query param", async () => {
    const res = await GET(makeReq({ url, method: "GET", token: TOKEN }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
  })
})
