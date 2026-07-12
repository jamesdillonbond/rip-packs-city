import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/webhook.
// endpointSecret (STRIPE_WEBHOOK_SECRET) is captured at IMPORT time, so it is set
// BEFORE the dynamic import below. Two pre-processing guards, in order:
//   1. !STRIPE_SECRET_KEY (call-time) || !endpointSecret (import-time) → 503 "Stripe not configured"
//   2. constructEvent(body, sig, secret) throws on a bad/missing signature → 400 "Invalid signature"
// Everything past the signature check is the Stripe event switch (real Stripe
// SDK + Supabase writes — import-only seam), so we pin the two guards. getStripe
// is mocked so constructEvent always throws (simulating an invalid signature).

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: () => {
        throw new Error("No signatures found matching the expected signature")
      },
    },
  }),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({ insert: async () => ({ error: null }) }) },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}) }),
}))

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test"
process.env.STRIPE_SECRET_KEY = "sk_test"

const { POST } = await import("@/app/api/stripe/webhook/route")

function post(sig?: string): NextRequest {
  const headers = new Headers({ "content-type": "application/json" })
  if (sig) headers.set("stripe-signature", sig)
  return new NextRequest("https://t/api/stripe/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "evt_1", type: "invoice.payment_succeeded" }),
  })
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test"
})
afterEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test"
})

describe("POST /api/stripe/webhook", () => {
  it("503s when Stripe is not configured (no STRIPE_SECRET_KEY)", async () => {
    delete process.env.STRIPE_SECRET_KEY
    const res = await POST(post("t=1,v1=abc"))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("Stripe not configured")
  })

  it("400s on an invalid/missing stripe-signature", async () => {
    const res = await POST(post())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid signature")
  })
})
