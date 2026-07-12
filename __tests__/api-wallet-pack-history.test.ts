import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-history. requireUser() runs
// first and throws a 401 Response when unauthenticated — in-test the cookie read
// resolves to no user, so the route fail-closes to 401 before the wallet guard.
// Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({}) } }))

import { GET } from "@/app/api/wallet/pack-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/wallet/pack-history", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/pack-history?wallet=0xabc"))
    expect(res.status).toBe(401)
  })
})
