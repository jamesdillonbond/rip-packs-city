import { describe, it, expect, beforeAll } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/golazos-listing-cache (POST delegates to GET).
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// TOKEN at import. The module ALSO throws at import if FLOWTY_PROXY_TOKEN is
// unset, so we set both env vars and dynamic-import the route. The real sweep
// runs in an after()-deferred lambda; the auth guard returns before it, so we
// only pin the fail-closed 401s (no token / wrong token / wrong ?token=).

let GET: (req: any) => Promise<Response>
let POST: (req: any) => Promise<Response>

beforeAll(async () => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.FLOWTY_PROXY_TOKEN = "test-flowty-proxy"
  const mod = await import("@/app/api/golazos-listing-cache/route")
  GET = mod.GET as any
  POST = mod.POST as any
})

const url = "https://t/api/golazos-listing-cache"

describe("GET/POST /api/golazos-listing-cache", () => {
  it("401s with no authorization header", async () => {
    const res = await GET(makeReq({ url, method: "GET" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong ?token= query param", async () => {
    const res = await GET(makeReq({ url, method: "GET", token: "nope" }))
    expect(res.status).toBe(401)
  })

  it("POST enforces the same auth (401 without a token)", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
  })
})
