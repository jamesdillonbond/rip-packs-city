import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/portal.
// Pre-Stripe guards, in order:
//   1. !getCurrentUser() → 401 "Authentication required"
//   2. missing/non-string walletAddress in the JSON body → 400 "walletAddress is required"
// Past those it does a saved_wallets ownership lookup and creates a Stripe
// billing-portal session (SDK network call — import-only seam). We pin the two
// pre-DB guards; getCurrentUser, the module-level @supabase/supabase-js client,
// and @/lib/stripe are mocked.

const auth: { user: any } = { user: null }

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }),
}))
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ billingPortal: { sessions: { create: async () => ({ url: "https://stripe/portal" }) } } }),
}))

import { POST } from "@/app/api/stripe/portal/route"

function post(body: any = {}): NextRequest {
  return new NextRequest("https://t/api/stripe/portal", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  auth.user = null
})

describe("POST /api/stripe/portal", () => {
  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s when walletAddress is missing", async () => {
    auth.user = { id: "u1" }
    const res = await POST(post({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("walletAddress is required")
  })
})
