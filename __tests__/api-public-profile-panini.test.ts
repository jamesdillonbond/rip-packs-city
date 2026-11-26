import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/public/profile/<username>/panini — the profile owner's linked Panini cards at their
// recorded value, inside the public Portfolio FMV (Trevor 2026-11-25). Pins: totals only (no
// username, no user id); a failed read is a 5xx, never $0; the profile's 404 passes through.

const state: { result: any; owner: string | null; value: any } = { result: null, owner: null, value: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/profile/public-profile", () => ({
  getPublicProfile: async () => state.result,
  publicProfileOwnerId: () => state.owner,
}))
vi.mock("@/lib/panini/linked-value", () => ({
  readLinkedPaniniValue: async (_sb: unknown, userId: string) => ({ ...state.value, _user: userId }),
}))

import { NextRequest } from "next/server"
import { GET } from "@/app/api/public/profile/[username]/panini/route"

const call = () => GET(new NextRequest("https://x.test/api/public/profile/trevor/panini"), { params: Promise.resolve({ username: "trevor" }) })

beforeEach(() => {
  state.result = { ok: true, data: { username: "trevor" } }
  state.owner = "user-1"
  state.value = { usernames: 1, unrecorded: 0, cards: 148, fmvUsd: 812.4, failed: false }
})

describe("GET /api/public/profile/<username>/panini", () => {
  it("passes the profile's 404 through", async () => {
    state.result = { ok: false, status: 404, error: "Not found" }
    expect((await call()).status).toBe(404)
  })
  it("publishes totals only", async () => {
    const res = await call()
    const body = await res.json()
    expect(body).toEqual({ cards: 148, fmv_usd: 812.4 })
    expect(JSON.stringify(body)).not.toContain("user-1")
    expect(res.headers.get("cache-control")).toContain("s-maxage=600")
  })
  it("a failed read is an error, never $0", async () => {
    state.value = { usernames: 1, unrecorded: 0, cards: 0, fmvUsd: 0, failed: true }
    expect((await call()).status).toBeGreaterThanOrEqual(500)
  })
})
