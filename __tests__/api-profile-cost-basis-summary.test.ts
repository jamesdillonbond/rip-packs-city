import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/cost-basis-summary.
// getCurrentUser()-gated but fail-SOFT: unauthenticated returns 200 with the
// zero-valued EMPTY_PAYLOAD + meta.unauthenticated (never 401) so the card
// renders an empty state. Pin the unauthenticated payload and the authed
// no-wallets path (get_user_saved_wallets [] → meta.no_wallets).

const state: { user: any; savedWallets: { data: any; error: any } } = {
  user: null,
  savedWallets: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) =>
      name === "get_user_saved_wallets" ? state.savedWallets : { data: [], error: null },
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/cost-basis-summary/route"

beforeEach(() => {
  state.user = null
  state.savedWallets = { data: [], error: null }
})

describe("GET /api/profile/cost-basis-summary", () => {
  it("returns the empty payload + meta.unauthenticated when not signed in (fail-soft)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ totalSpent: 0, totalPurchases: 0, totalFmv: 0, netPL: 0, plPercent: null })
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns meta.no_wallets for an authed user with no saved wallets", async () => {
    state.user = { id: "u1" }
    state.savedWallets = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalSpent).toBe(0)
    expect(body.meta.no_wallets).toBe(true)
  })

  it("returns meta.saved_wallets_unavailable when the wallet RPC errors", async () => {
    state.user = { id: "u1" }
    state.savedWallets = { data: null, error: { message: "db", code: "500" } }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).meta.saved_wallets_unavailable).toBe(true)
  })
})
