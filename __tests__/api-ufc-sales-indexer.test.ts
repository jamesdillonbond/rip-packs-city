import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/ufc-sales-indexer. Bearer INGEST_SECRET_TOKEN
// (or ?token=) gated → fail-closed 401 (GET and POST both delegate to the guarded
// runIndexer). The on-chain triple-path scan is out of scope. NOTE: only the auth
// guard is pinned. Mocks supabaseAdmin + the V1 tx decoder.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))
vi.mock("@/lib/dapper-v1-tx-decode", () => ({ decodeV1SaleTx: async () => null }))

import { GET, POST } from "@/app/api/ufc-sales-indexer/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("/api/ufc-sales-indexer — fail-closed auth", () => {
  it("POST 401s without a token", async () => {
    expect((await POST(req("https://t/api/ufc-sales-indexer"))).status).toBe(401)
  })
  it("GET 401s without a token", async () => {
    expect((await GET(req("https://t/api/ufc-sales-indexer"))).status).toBe(401)
  })
})
