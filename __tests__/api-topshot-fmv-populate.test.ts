import { describe, it, expect, vi } from "vitest"

// Route integration test for /api/topshot-fmv-populate. Bearer INGEST_SECRET_TOKEN
// (or ?token=) gated → fail-closed 401 (TOKEN is captured at module load from an
// unset env in-test). The sweep itself runs in after() and is out of scope.
// NOTE: only the auth guard is pinned. Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }) } }))

import { GET, POST } from "@/app/api/topshot-fmv-populate/route"

const req = (u: string, headers: Record<string, string> = {}) =>
  ({ nextUrl: new URL(u), headers: new Headers(headers) }) as any

describe("/api/topshot-fmv-populate — fail-closed auth", () => {
  it("GET 401s without a token", async () => {
    expect((await GET(req("https://t/api/topshot-fmv-populate"))).status).toBe(401)
  })
  it("POST 401s without a token", async () => {
    expect((await POST(req("https://t/api/topshot-fmv-populate"))).status).toBe(401)
  })
  it("401s even with a token (expected TOKEN unset in-test)", async () => {
    expect((await GET(req("https://t/api/topshot-fmv-populate?token=x"))).status).toBe(401)
  })
})
