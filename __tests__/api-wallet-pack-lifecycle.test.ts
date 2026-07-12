import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/wallet/pack-lifecycle. requireUser() runs
// first → fail-closed 401 when unauthenticated (no cookie in-test), before the
// wallet/packNftId guard. Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({}) } }))

import { GET } from "@/app/api/wallet/pack-lifecycle/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/wallet/pack-lifecycle", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/pack-lifecycle?wallet=0xabc&packNftId=1"))
    expect(res.status).toBe(401)
  })
})
