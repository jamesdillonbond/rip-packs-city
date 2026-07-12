import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/pro-payment-scanner.
// Auth is Bearer against a module-level TOKEN read from INGEST_SECRET_TOKEN at
// IMPORT time, so the env is set before the dynamic import. We pin the
// fail-closed auth guard only.
// NOTE: import-only for the happy path — the scan makes a live Flow REST POST
// (rest-mainnet.onflow.org) with a base64 JSON-CDC decode and no clean mock
// seam, so we assert the guards + that GET is a function rather than mocking the
// full chain fetch.

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { GET } = await import("@/app/api/pro-payment-scanner/route")

function get(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/pro-payment-scanner", { method: "GET", headers })
}

describe("GET /api/pro-payment-scanner", () => {
  it("exports a GET handler", () => {
    expect(typeof GET).toBe("function")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await GET(get("Bearer wrong"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with no authorization header", async () => {
    expect((await GET(get())).status).toBe(401)
  })
})
