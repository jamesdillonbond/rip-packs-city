import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/allday-ingest (deprecated no-op).
// checkAuth() reads INGEST_SECRET_TOKEN at call time and accepts a Bearer
// header OR a ?token= query param; a missing/empty token returns false → 401.
// GET simply delegates to POST. We pin the fail-closed auth guard and the
// 200 no-op payload with a matching token.

import { POST, GET } from "@/app/api/allday-ingest/route"

const TOKEN = "test-ingest-token"

function req(opts: { auth?: string; token?: string } = {}): NextRequest {
  const headers = new Headers()
  if (opts.auth) headers.set("authorization", opts.auth)
  const url = "https://t/api/allday-ingest" + (opts.token ? `?token=${opts.token}` : "")
  return new NextRequest(url, { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("/api/allday-ingest", () => {
  it("401s without a token", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req({ auth: "Bearer wrong" }))).status).toBe(401)
  })

  it("401s when the server token is unset (fail-closed)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    expect((await POST(req({ auth: `Bearer ${TOKEN}` }))).status).toBe(401)
  })

  it("returns the 200 no-op payload with a matching bearer token", async () => {
    const res = await POST(req({ auth: `Bearer ${TOKEN}` }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe("flowty_api_empty")
  })

  it("accepts the token via ?token= query param", async () => {
    expect((await POST(req({ token: TOKEN }))).status).toBe(200)
  })

  it("GET delegates to POST (401 without a token)", async () => {
    expect((await GET(req())).status).toBe(401)
  })
})
