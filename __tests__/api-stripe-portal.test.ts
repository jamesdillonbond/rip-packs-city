import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/portal.
// Pre-Stripe guards, in order:
//   1. !getCurrentUser() → 401 "Authentication required"
//   2. missing/non-string walletAddress in the JSON body → 400 "walletAddress is required"
// Past those it does a saved_wallets ownership lookup + a pro_users
// stripe_customer_id lookup, then creates a Stripe billing-portal session. The
// createClient mock resolves per-table maybeSingle fixtures so the success path
// reaches the (mocked) Stripe portal url.

const auth: { user: any } = { user: null }
const db: { single: Record<string, any> } = { single: {} }

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))
vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (t: string) => {
    const b: any = {
      select: () => b, eq: () => b,
      maybeSingle: async () => db.single[t] ?? { data: null, error: null },
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => makeBuilder(t) }) }
})
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
  db.single = {}
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

  it("403s when the wallet is not linked to the account", async () => {
    auth.user = { id: "u1" }
    db.single.saved_wallets = { data: null, error: null }
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(403)
  })

  it("404s when no active subscription (no stripe_customer_id)", async () => {
    auth.user = { id: "u1" }
    db.single.saved_wallets = { data: { wallet_addr: "0xabc" }, error: null }
    db.single.pro_users = { data: null, error: null }
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(404)
  })

  it("200s and returns the billing-portal url for a linked subscriber", async () => {
    auth.user = { id: "u1" }
    db.single.saved_wallets = { data: { wallet_addr: "0xabc" }, error: null }
    db.single.pro_users = { data: { stripe_customer_id: "cus_123" }, error: null }
    const res = await POST(post({ walletAddress: "0xABC" }))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe("https://stripe/portal")
  })
})
