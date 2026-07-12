import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/checkout.
// Two pre-Stripe guards, in order:
//   1. !STRIPE_SECRET_KEY || !PRO_PRICE_ID → 503 "Stripe not configured"
//   2. !getCurrentUser() → 401 "Authentication required"
// The actual Checkout session creation is a Stripe-SDK network call (import-only
// seam), so we pin the two guards. getCurrentUser + @/lib/stripe are mocked.

const auth: { user: any } = { user: null }

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: async () => ({ url: "https://stripe/x" }) } } }),
  PRO_PRICE_ID: "price_test",
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))

import { POST } from "@/app/api/stripe/checkout/route"

function post(body: any = {}): NextRequest {
  return new NextRequest("https://t/api/stripe/checkout", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test"
  auth.user = null
})
afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY
})

describe("POST /api/stripe/checkout", () => {
  it("503s when Stripe is not configured (no STRIPE_SECRET_KEY)", async () => {
    delete process.env.STRIPE_SECRET_KEY
    const res = await POST(post())
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("Stripe not configured")
  })

  it("401s when unauthenticated", async () => {
    auth.user = null
    const res = await POST(post())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })
})
