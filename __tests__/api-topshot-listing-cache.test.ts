import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/topshot-listing-cache. Bearer
// INGEST_SECRET_TOKEN (or ?token=) gated → fail-closed 401. The module throws at
// import unless FLOWTY_PROXY_TOKEN is set, so vi.hoisted seeds it before the
// route import runs. The paginated fetch/upsert runs in after() and is out of
// scope. NOTE: only the auth guard is pinned. Mocks supabaseAdmin.

vi.hoisted(() => { process.env.FLOWTY_PROXY_TOKEN ||= "test-flowty-token" })
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET } from "@/app/api/topshot-listing-cache/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("GET /api/topshot-listing-cache — fail-closed auth", () => {
  it("401s without a token", async () => {
    expect((await GET(req("https://t/api/topshot-listing-cache"))).status).toBe(401)
  })
  it("401s with a bogus token (expected TOKEN unset in-test)", async () => {
    expect((await GET(req("https://t/api/topshot-listing-cache?token=x"))).status).toBe(401)
  })
})
