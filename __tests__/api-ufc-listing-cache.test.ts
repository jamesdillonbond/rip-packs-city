import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/ufc-listing-cache. Bearer INGEST_SECRET_TOKEN
// (or ?token=) gated → fail-closed 401. The paginated Flowty fetch/upsert runs in
// after() and is out of scope. NOTE: only the auth guard is pinned. Mocks
// supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET } from "@/app/api/ufc-listing-cache/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("GET /api/ufc-listing-cache — fail-closed auth", () => {
  it("401s without a token", async () => {
    expect((await GET(req("https://t/api/ufc-listing-cache"))).status).toBe(401)
  })
  it("401s with a bogus token (expected TOKEN unset in-test)", async () => {
    expect((await GET(req("https://t/api/ufc-listing-cache?token=x"))).status).toBe(401)
  })
})
