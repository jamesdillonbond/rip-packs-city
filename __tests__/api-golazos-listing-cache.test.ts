import { describe, it, expect, beforeAll, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/golazos-listing-cache (POST delegates to GET).
// The module THROWS at import unless FLOWTY_PROXY_TOKEN is set, so we seed it in
// every regime before the dynamic import. Auth: Bearer INGEST_SECRET_TOKEN or
// ?token= into a module-level `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""`
// (`!TOKEN || (bearer!==TOKEN && urlToken!==TOKEN)` → 401). Two regimes via
// resetModules:
//   A. no secret → TOKEN "" → every request 401s (fail-closed).
//   B. secret set → wrong/no token 401; correct token reaches the 200 accept
//      ({status:"accepted"}). GET (and POST, which delegates to it) defers the
//      dual-sort Flowty sweep to after() (stubbed no-op), so the accept is
//      observable without any Flowty/DB I/O.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))

const url = "https://t/api/golazos-listing-cache"

describe("GET/POST /api/golazos-listing-cache — no secret configured (fail-closed)", () => {
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    delete process.env.INGEST_SECRET_TOKEN
    process.env.FLOWTY_PROXY_TOKEN = "test-flowty-proxy"
    const mod = await import("@/app/api/golazos-listing-cache/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("401s with no authorization header", async () => {
    const res = await GET(makeReq({ url, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })
  it("401s with a wrong bearer token", async () => {
    expect((await GET(makeReq({ url, method: "GET", auth: "Bearer nope" }))).status).toBe(401)
  })
  it("401s with a wrong ?token= query param", async () => {
    expect((await GET(makeReq({ url, method: "GET", token: "nope" }))).status).toBe(401)
  })
  it("POST enforces the same auth (401 without a token)", async () => {
    expect((await POST(makeReq({ url }))).status).toBe(401)
  })
})

describe("GET/POST /api/golazos-listing-cache — secret configured (accept path)", () => {
  const TOKEN = "golazos-listing-cache-token"
  let GET: (req: any) => Promise<Response>
  let POST: (req: any) => Promise<Response>
  beforeAll(async () => {
    vi.resetModules()
    process.env.INGEST_SECRET_TOKEN = TOKEN
    process.env.FLOWTY_PROXY_TOKEN = "test-flowty-proxy"
    const mod = await import("@/app/api/golazos-listing-cache/route")
    GET = mod.GET as any
    POST = mod.POST as any
  })

  it("still 401s with no / wrong token", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
    expect((await GET(makeReq({ url, method: "GET", auth: "Bearer nope" }))).status).toBe(401)
  })

  it("GET 200s and reports the background-accept with the correct bearer token", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("accepted")
    expect(body.message).toContain("golazos-listing-cache")
  })

  it("GET 200s with the correct ?token= query param", async () => {
    const res = await GET(makeReq({ url, method: "GET", token: TOKEN }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
  })

  it("POST delegates to GET (same auth + accept)", async () => {
    const res = await POST(makeReq({ url, auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe("accepted")
  })
})
