import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/trade-hub/matches. Cookie-auth gated →
// fail-closed 401 when unauthenticated (getCurrentUser → null). Mocks
// supabaseAdmin + the auth helper.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({}) } }))
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => null }))

import { GET } from "@/app/api/trade-hub/matches/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/trade-hub/matches", () => {
  it("401s when unauthenticated", async () => {
    expect((await GET(req("https://t/api/trade-hub/matches"))).status).toBe(401)
  })
})
