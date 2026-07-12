import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/ufc-listings-indexer. Bearer INGEST_SECRET_TOKEN
// (or ?token=) gated → fail-closed 401 (GET delegates to POST). The triple
// storefront scan runs in after() and is out of scope. NOTE: only the auth guard
// is pinned. Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/ufc-listings-indexer/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("/api/ufc-listings-indexer — fail-closed auth", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(req("https://t/api/ufc-listings-indexer"))).status).toBe(401)
  })
  it("GET 401s without a token", async () => {
    expect((await GET(req("https://t/api/ufc-listings-indexer"))).status).toBe(401)
  })
})
