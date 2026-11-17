import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/badge-sync.
// POST is gated `!INGEST_SECRET_TOKEN || bearer !== token` (read at call time) →
// 401 before the multi-badge GQL sweep. GET is read-only — an RPC that returns
// per-collection badge_editions counts. Mock @/lib/supabase for the GET happy +
// error branches.

const rpc: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { POST, GET } from "@/app/api/badge-sync/route"

const TOKEN = "test-ingest-token"

function postReq(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/badge-sync", { method: "POST", headers })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
  rpc.data = []
  rpc.error = null
})
afterEach(() => {
  process.env.INGEST_SECRET_TOKEN = TOKEN
})

describe("/api/badge-sync", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(postReq())).status).toBe(401)
  })

  it("POST 401s with a wrong token", async () => {
    expect((await POST(postReq("Bearer wrong"))).status).toBe(401)
  })

  it("GET returns per-collection counts + total", async () => {
    rpc.data = [
      { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", count: 10 },
      { collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", count: 5 },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(15)
    expect(body.counts["95f28a17-224a-4025-96ad-adf8a4c63bfd"]).toBe(10)
  })

  it("GET 500s on an RPC error", async () => {
    rpc.error = { message: "db down" }
    expect((await GET()).status).toBe(500)
  })
})
