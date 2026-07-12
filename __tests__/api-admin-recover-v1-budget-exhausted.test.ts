import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/recover-v1-budget-exhausted (POST).
// Auth is Bearer INGEST_SECRET_TOKEN ONLY, captured into a module-level TOKEN at
// import time — so the env is set before importing. Fire-and-forget via after()
// (stubbed no-op). Pins the fail-closed 401 and the immediate 200 queued.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => ({ priceCertain: false }) }))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { POST } = await import("@/app/api/admin/recover-v1-budget-exhausted/route")

function post(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/recover-v1-budget-exhausted", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/admin/recover-v1-budget-exhausted", () => {
  it("401s without the Bearer token", async () => {
    expect((await POST(post("Bearer wrong"))).status).toBe(401)
  })

  it("returns 200 queued with the matching token", async () => {
    const res = await POST(post(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(true)
  })
})
