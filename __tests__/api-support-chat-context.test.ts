import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/support-chat/context. Chat-widget preload
// endpoint — no hard auth guard (identity is derived best-effort from the cookie
// and falls back to nulls). With no sessionId and market status off, it returns
// the default beta-posture welcome payload. Mocks @supabase/supabase-js and the
// server auth helper.

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, eq: () => b, ilike: () => b, order: () => b, gt: () => b,
    gte: () => b, lt: () => b, not: () => b, limit: () => b,
    maybeSingle: async () => ({ data: null }),
    then: (resolve: any) => resolve({ data: null, count: 0 }),
  }
  return { createClient: () => ({ from: () => b, rpc: async () => ({ data: null }) }) }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
}))

import { GET } from "@/app/api/support-chat/context/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/support-chat/context", () => {
  it("returns the default preload payload for an anonymous, session-less open", async () => {
    const res = await GET(req("https://t/api/support-chat/context"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.returningUser).toBe(false)
    expect(body.returningBetaTester).toBe(false)
    expect(typeof body.pageWelcome).toBe("string")
    expect(Array.isArray(body.pageSuggestions)).toBe(true)
    // Market context is gated behind includeMarketStatus — off by default.
    expect(body.dailyDeal).toBeNull()
    expect(body.marketPulse).toBeNull()
  })
})
