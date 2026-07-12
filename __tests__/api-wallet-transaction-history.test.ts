import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/wallet/transaction-history. requireUser()
// runs first → fail-closed 401 when unauthenticated (no cookie in-test), before
// the wallet/kind guard. Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}), rpc: async () => ({}) } }))

import { GET } from "@/app/api/wallet/transaction-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/wallet/transaction-history", () => {
  it("401s when unauthenticated (requireUser fail-closed)", async () => {
    const res = await GET(req("https://t/api/wallet/transaction-history?wallet=0xabc"))
    expect(res.status).toBe(401)
  })
})
