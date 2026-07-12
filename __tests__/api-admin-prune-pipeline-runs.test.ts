import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/prune-pipeline-runs (POST).
// Auth is Bearer INGEST_SECRET_TOKEN ONLY, read into a module-level TOKEN at
// import time, so the env must be set BEFORE importing the route. Fire-and-
// forget via after() — stubbed to a no-op so the immediate 200 is observable
// without a request scope.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: { deleted: 0 }, error: null }) },
}))

const TOKEN = "test-ingest-token"
process.env.INGEST_SECRET_TOKEN = TOKEN

const { POST } = await import("@/app/api/admin/prune-pipeline-runs/route")

function post(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/prune-pipeline-runs", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("POST /api/admin/prune-pipeline-runs", () => {
  it("401s without the Bearer token", async () => {
    expect((await POST(post("Bearer wrong"))).status).toBe(401)
    expect((await POST(post())).status).toBe(401)
  })

  it("returns 200 queued with the matching token", async () => {
    const res = await POST(post(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.queued).toBe(true)
    expect(body.keep_days).toBe(7)
  })
})
