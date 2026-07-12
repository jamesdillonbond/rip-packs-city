import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest (POST + GET alias).
// Auth: Bearer INGEST_SECRET_TOKEN, checked INSIDE the handler as
// `if (expectedToken && authHeader !== ...)` (REQUEST time). The real ingest
// runs in an after()-deferred lambda; after() is stubbed to a no-op so the
// heavy Top Shot GQL + Supabase fan-out never executes and the immediate
// 200 { ok:true, message:"Ingest triggered" } accept is observable.
// NOTE: when INGEST_SECRET_TOKEN is unset the route is intentionally open (no
// token to enforce) — so the fail-closed tests require the secret to be SET.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({}), rpc: async () => ({ data: null, error: null }) },
}))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))
vi.mock("@/lib/pipeline-chain", () => ({ fireNextPipelineStep: async () => {} }))
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateTopShotEditions: async () => [],
  toUpsertRow: (r: any) => r,
}))

import { POST, GET } from "@/app/api/ingest/route"

const savedIngest = process.env.INGEST_SECRET_TOKEN
const url = "https://t/api/ingest"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

afterEach(() => {
  if (savedIngest === undefined) delete process.env.INGEST_SECRET_TOKEN
  else process.env.INGEST_SECRET_TOKEN = savedIngest
})

describe("POST /api/ingest — auth guards", () => {
  it("401s with no authorization header when the secret is set", async () => {
    const res = await POST(makeReq({ url }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(makeReq({ url, auth: "Bearer nope" }))).status).toBe(401)
  })

  it("GET alias enforces the same auth (401 without a token)", async () => {
    expect((await GET(makeReq({ url, method: "GET" }))).status).toBe(401)
  })
})

describe("POST /api/ingest — success path (immediate ack, ingest deferred)", () => {
  it("200s and reports 'Ingest triggered' with the correct bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.message).toBe("Ingest triggered")
    expect(typeof body.triggeredAt).toBe("string")
  })

  it("GET alias reaches the same 200 accept when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
