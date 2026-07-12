import { describe, it, expect, beforeAll } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/golazos-sales-indexer (POST + GET alias).
// Auth: Bearer INGEST_SECRET_TOKEN OR ?token=, captured into a module-level
// `TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""` at import. We dynamic-import
// with the secret DELETED so TOKEN === "" — the strongest fail-closed case:
// `if (!TOKEN || ...)` 401s every request when no secret is configured. The
// on-chain scan is after()-deferred and never reached past the guard.

let POST: (req: any) => Promise<Response>
let GET: (req: any) => Promise<Response>

beforeAll(async () => {
  delete process.env.INGEST_SECRET_TOKEN
  const mod = await import("@/app/api/golazos-sales-indexer/route")
  POST = mod.POST as any
  GET = mod.GET as any
})

const url = "https://t/api/golazos-sales-indexer"

describe("POST /api/golazos-sales-indexer", () => {
  it("401s fail-closed with no secret configured and no token", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s fail-closed even with a bearer token when no secret is configured", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer anything" }))
    expect(res.status).toBe(401)
  })

  it("401s fail-closed even with a ?token= when no secret is configured", async () => {
    const res = await POST(makeReq({ url, token: "anything" }))
    expect(res.status).toBe(401)
  })

  it("GET alias enforces the same guard", async () => {
    const res = await GET(makeReq({ url, method: "GET" }))
    expect(res.status).toBe(401)
  })
})
