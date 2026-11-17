import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/stripe/portal.
// Pre-Stripe guards, in order:
//   1. !getCurrentUser() → 401 "Authentication required"
//   2. missing/non-string walletAddress in the JSON body → 400 "walletAddress is required"
// Past those it requires the caller to OWN the wallet (requireOwnedKey) + a pro_users
// stripe_customer_id lookup, then creates a Stripe billing-portal session. The
// createClient mock resolves per-table maybeSingle fixtures so the success path
// reaches the (mocked) Stripe portal url.

const auth: { user: any } = { user: null }
// Owner of each wallet per lib/auth/owner-key-guard (verified, else first saver).
const owners: Record<string, string> = {}
const db: { single: Record<string, any> } = { single: {} }

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => auth.user,
}))
vi.mock("@/lib/auth/owner-key-guard", () => ({
  requireOwnedKey: async (key: string) =>
    !auth.user
      ? new Response("{}", { status: 401 })
      : owners[key] === auth.user.id
        ? { user: auth.user }
        : new Response("{}", { status: 403 }),
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
  for (const k of Object.keys(owners)) delete owners[k]
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
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(403)
  })

  it("403s an account that SAVED the wallet but does not own it — no portal session for someone else's subscription", async () => {
    auth.user = { id: "squatter" }
    owners["0xabc"] = "real-owner"
    db.single.saved_wallets = { data: { wallet_addr: "0xabc" }, error: null } // saved, but not first / verified
    db.single.pro_users = { data: { stripe_customer_id: "cus_123" }, error: null }
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(403)
    expect((await res.json()).url).toBeUndefined()
  })

  it("404s when no active subscription (no stripe_customer_id)", async () => {
    auth.user = { id: "u1" }
    owners["0xabc"] = "u1"
    db.single.pro_users = { data: null, error: null }
    const res = await POST(post({ walletAddress: "0xabc" }))
    expect(res.status).toBe(404)
  })

  it("200s and returns the billing-portal url for a linked subscriber", async () => {
    auth.user = { id: "u1" }
    owners["0xabc"] = "u1"
    db.single.pro_users = { data: { stripe_customer_id: "cus_123" }, error: null }
    const res = await POST(post({ walletAddress: "0xABC" }))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toBe("https://stripe/portal")
  })
})
