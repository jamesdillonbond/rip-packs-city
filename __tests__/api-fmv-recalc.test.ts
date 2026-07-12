import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/fmv-recalc (POST + GET alias).
// Same token gate as ingest/fmv-backfill: Bearer INGEST_SECRET_TOKEN (or
// CRON_SECRET). Fail-closed priority — 500 when the secret is unset, 401 on
// no / wrong token. All guards return before the paginated sweep touches the DB.

import { POST, GET } from "@/app/api/fmv-recalc/route"

const savedIngest = process.env.INGEST_SECRET_TOKEN
const savedCron = process.env.CRON_SECRET

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  delete process.env.CRON_SECRET
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
  if (savedCron === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedCron
})

describe("POST /api/fmv-recalc", () => {
  it("500s when INGEST_SECRET_TOKEN is not set (fail-closed misconfig)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(makeReq({ url: "https://t/api/fmv-recalc" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("INGEST_SECRET_TOKEN not set")
  })

  it("401s with no authorization header", async () => {
    const res = await POST(makeReq({ url: "https://t/api/fmv-recalc" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: "https://t/api/fmv-recalc", auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("GET alias enforces the same auth (401 without a token)", async () => {
    const res = await GET(makeReq({ url: "https://t/api/fmv-recalc", method: "GET" }))
    expect(res.status).toBe(401)
  })
})
