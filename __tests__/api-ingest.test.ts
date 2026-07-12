import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest (POST + GET alias).
// Auth: Bearer INGEST_SECRET_TOKEN, checked INSIDE the handler as
// `if (expectedToken && authHeader !== ...)`. The real work runs in an
// after()-deferred lambda; we only pin the fail-closed guard, which returns
// before after() is registered. NOTE: when INGEST_SECRET_TOKEN is unset the
// route is intentionally open (no token to enforce) — so the fail-closed test
// requires the secret to be SET, then supplies no / a wrong token.

import { POST, GET } from "@/app/api/ingest/route"

const savedIngest = process.env.INGEST_SECRET_TOKEN

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("POST /api/ingest", () => {
  it("401s with no authorization header when the secret is set", async () => {
    const res = await POST(makeReq({ url: "https://t/api/ingest" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: "https://t/api/ingest", auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("GET alias enforces the same auth (401 without a token)", async () => {
    const res = await GET(makeReq({ url: "https://t/api/ingest", method: "GET" }))
    expect(res.status).toBe(401)
  })
})
