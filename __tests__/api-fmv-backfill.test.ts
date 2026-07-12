import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/fmv-backfill (POST + GET alias).
// Bearer-gated on INGEST_SECRET_TOKEN (CRON_SECRET also accepted). Fail-closed
// priority: 500 when the secret env is UNSET (server misconfigured), 401 with
// no / wrong token. PLUS the 2xx success path: authed + the fmv_backfill_candidates
// anti-join RPC returns no candidates -> early 200 { ok:true, editionsFound:0 }
// (Supabase rpc stubbed to empty).

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: [], error: null }) },
}))

import { POST, GET } from "@/app/api/fmv-backfill/route"

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

describe("POST /api/fmv-backfill", () => {
  it("500s when INGEST_SECRET_TOKEN is not set (fail-closed misconfig)", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    const res = await POST(makeReq({ url: "https://t/api/fmv-backfill" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("INGEST_SECRET_TOKEN not set")
  })

  it("401s with no authorization header", async () => {
    const res = await POST(makeReq({ url: "https://t/api/fmv-backfill" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: "https://t/api/fmv-backfill", auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("GET alias enforces the same auth (401 without a token)", async () => {
    const res = await GET(makeReq({ url: "https://t/api/fmv-backfill", method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("200s (authed) reporting zero candidates when the anti-join RPC is empty", async () => {
    const res = await POST(
      makeReq({ url: "https://t/api/fmv-backfill", auth: "Bearer test-ingest-secret" }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editionsFound).toBe(0)
    expect(body.snapshotsInserted).toBe(0)
  })
})
