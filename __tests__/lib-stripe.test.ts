import { describe, it, expect, beforeEach } from "vitest"

// lib/stripe — the lazy client factory. Fail-closed without a key; memoized
// once constructed (same instance across calls).

const { getStripe, PRO_PRICE_ID } = await import("@/lib/stripe")

beforeEach(() => {
  delete process.env.STRIPE_SECRET_KEY
})

describe("lib/stripe", () => {
  it("throws (fail-closed) when STRIPE_SECRET_KEY is not configured", () => {
    expect(() => getStripe()).toThrow("STRIPE_SECRET_KEY not configured")
  })

  it("constructs once and memoizes the client", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123"
    const a = getStripe()
    const b = getStripe()
    expect(a).toBe(b)
    expect(typeof a.webhooks?.constructEvent).toBe("function")
  })

  it("exposes PRO_PRICE_ID as a string (env-derived, may be empty in tests)", () => {
    expect(typeof PRO_PRICE_ID).toBe("string")
  })
})
