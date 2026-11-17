import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/webhook.
// endpointSecret (STRIPE_WEBHOOK_SECRET) is captured at IMPORT time, so it is set
// BEFORE the dynamic import below. Two pre-processing guards, in order:
//   1. !STRIPE_SECRET_KEY (call-time) || !endpointSecret (import-time) → 503 "Stripe not configured"
//   2. constructEvent(body, sig, secret) throws on a bad/missing signature → 400 "Invalid signature"
// Success path: constructEvent returns a signed invoice.payment_succeeded event
// carrying user_id metadata → the route routes it through activate_pro_from_stripe
// (mocked RPC) and returns { received: true }. A hoisted holder lets one mocked
// constructEvent both throw (guard) and return (success).

const h = vi.hoisted(() => ({ shouldThrow: true, event: null as any }))

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: () => {
        if (h.shouldThrow) throw new Error("No signatures found matching the expected signature")
        return h.event
      },
    },
    subscriptions: { retrieve: async () => ({ current_period_end: 1 }) },
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
  h.shouldThrow = true
  h.event = null
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

  it("200s { received: true } on a verified invoice.payment_succeeded event", async () => {
    h.shouldThrow = false
    h.event = {
      id: "evt_1",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          subscription: "sub_1",
          customer: "cus_1",
          amount_paid: 999,
          subscription_details: { metadata: { user_id: "u1" } },
          lines: { data: [] },
        },
      },
    }
    const res = await POST(post("t=1,v1=validsig"))
    expect(res.status).toBe(200)
    expect((await res.json()).received).toBe(true)
  })
})
