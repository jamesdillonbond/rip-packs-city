import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/profile/unclaimed-rewards (2026-11-15): signed-in only; the
// rewards list on success; a failed read is a 503-family error body, NEVER
// `{ rewards: [] }` (the dashboard card would read that as "nothing earned").

const auth: { user: any } = { user: null }
const reward: { impl: () => Promise<unknown> } = { impl: async () => [] }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/giveaways/challenge-reward", () => ({ unclaimedRewardsForUser: () => reward.impl() }))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!auth.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return auth.user
  },
}))

import { GET } from "@/app/api/profile/unclaimed-rewards/route"

describe("GET /api/profile/unclaimed-rewards", () => {
  beforeEach(() => {
    auth.user = { id: "u1" }
    reward.impl = async () => []
  })
  it("401 when signed out", async () => {
    auth.user = null
    expect((await GET()).status).toBe(401)
  })
  it("returns the rewards, no-store", async () => {
    const r = [{ drop: { slug: "dt", title: "Dame Time Challenge Reward Pack" }, challenge: { slug: "dame-time", title: "Dame Time" }, packsLeft: 6 }]
    reward.impl = async () => r
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(await res.json()).toEqual({ rewards: r })
  })
  it("a failed read is an error status without a rewards array — never an empty list", async () => {
    reward.impl = async () => {
      throw new Error("trophy_cases read failed: canceling statement due to statement timeout")
    }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(body).not.toHaveProperty("rewards")
    expect(JSON.stringify(body)).not.toMatch(/canceling statement/)
  })
})
