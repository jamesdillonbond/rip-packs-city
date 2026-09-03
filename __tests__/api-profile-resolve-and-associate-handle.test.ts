import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// /api/profile/resolve-and-associate — the handle default.
//
// This is the only path on which RPC learns a collector's Dapper username, and
// until 2026-08-13 nothing but a manual visit to /profile/edit ever set
// profile_bio.username — so 16 of 20 signed-up collectors had no public profile.
//
// Kept in its own file rather than added to api-profile-resolve-and-associate:
// that suite's Supabase stub has no `maybeSingle`, which is exactly what the
// claim needs. Widening the shared stub would have re-baselined 12 passing
// tests to prove one new thing. (Its stub's absence is itself informative — the
// claim degrades to a no-op there and the route still returns 200, which is the
// fail-soft property this file also asserts directly.)
// ─────────────────────────────────────────────────────────────────────────────

const captured: { fn: null | (() => Promise<void>) } = { fn: null }
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: any) => { captured.fn = fn } }
})

const state: {
  user: any
  resolved: any
  bioRow: { username: string | null } | null
  bioReadErr: any
  bioWriteErr: any
  upserts: any[]
} = {
  user: { id: "u-1" },
  resolved: { walletAddress: "0x1111111111111111", username: "Rigged", dapperId: null },
  bioRow: null,
  bioReadErr: null,
  bioWriteErr: null,
  upserts: [],
}

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: state.bioRow, error: state.bioReadErr }),
      upsert: (payload: any) => {
        if (table === "profile_bio") {
          state.upserts.push(payload)
          return Promise.resolve({ error: state.bioWriteErr })
        }
        return b
      },
      then: (resolve: any) => resolve({ data: [], error: null }),
    }
    return b
  }
  const client: any = { from: (t: string) => build(t), rpc: async () => ({ data: 1, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))
// ⚠ The route moved to the cache-aware resolver 2026-09-03 (see the sibling
// test's note): live-GQL-only meant an outage 502'd signups for handles we
// already had cached.
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  resolveTopShotUsernameCacheAware: async () =>
    state.resolved
      ? { found: true, ...state.resolved, source: "wallet_usernames", cacheLayer: "wallet_usernames" }
      : { found: false, reason: "username_not_found_on_topshot" },
}))
vi.mock("@/lib/pro-tier", () => ({ checkFeatureQuota: async () => ({ daily_limit: null, plan: "free" }) }))
vi.mock("@/lib/profile/warm-wallet", () => ({ warmWalletDeep: async () => {} }))

import { POST } from "@/app/api/profile/resolve-and-associate/route"

const req = (body: any) =>
  ({ url: "https://t/api/profile/resolve-and-associate", json: async () => body }) as any

beforeEach(() => {
  captured.fn = null
  state.user = { id: "u-1" }
  state.resolved = { walletAddress: "0x1111111111111111", username: "Rigged", dapperId: null }
  state.bioRow = null
  state.bioReadErr = null
  state.bioWriteErr = null
  state.upserts = []
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
})
afterEach(() => vi.unstubAllGlobals())

describe("handle defaults to the Dapper/Top Shot username", () => {
  it("claims the normalized handle on first association", async () => {
    const res = await POST(req({ username: "Rigged" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.profileHandle).toBe("rigged")
    expect(body.profileHandleClaimed).toBe(true)
    expect(state.upserts[0]).toMatchObject({ user_id: "u-1", username: "rigged" })
  })

  it("reports the EXISTING handle on a re-resolve, and claims nothing", async () => {
    // Collectors re-run this path whenever they refresh a collection. The
    // dashboard keys its "your profile is live" toast on `claimed`, so a false
    // here is what stops it re-announcing a profile they've had for weeks.
    state.bioRow = { username: "chosen-by-hand" }
    const body = await (await POST(req({ username: "Rigged" }))).json()
    expect(body.profileHandleClaimed).toBe(false)
    expect(body.profileHandle).toBe("chosen-by-hand")
    expect(state.upserts).toHaveLength(0)
  })

  it("does not claim anything on the wallet-ADDRESS path", async () => {
    // No Dapper name is resolved there, so there is nothing to derive from —
    // and inventing a handle out of a hex address would be worse than none.
    const body = await (await POST(req({ address: "0x2222222222222222" }))).json()
    expect(body.profileHandleClaimed).toBe(false)
    expect(body.profileHandle).toBeNull()
    expect(state.upserts).toHaveLength(0)
  })

  it("still associates the wallet when the handle is TAKEN", async () => {
    state.bioWriteErr = { code: "23505" }
    const res = await POST(req({ username: "Rigged" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.profileHandleClaimed).toBe(false)
    expect(body.walletAddress).toBe("0x1111111111111111")
    expect(body.associatedCollections.length).toBeGreaterThan(0)
  })

  it("still associates the wallet when the handle write ERRORS", async () => {
    // The wallet rows are the point of this endpoint; the handle is a bonus.
    // A claim that can 500 the association would trade the feature for the
    // reason people are here.
    state.bioWriteErr = { code: "57014", message: "statement timeout" }
    const res = await POST(req({ username: "Rigged" }))
    expect(res.status).toBe(200)
    expect((await res.json()).profileHandleClaimed).toBe(false)
  })

  it("still associates the wallet when the handle READ errors", async () => {
    state.bioReadErr = { message: "pool timeout" }
    const res = await POST(req({ username: "Rigged" }))
    expect(res.status).toBe(200)
    expect(state.upserts).toHaveLength(0)
  })

  it("does not leak the driver's message when the claim fails", async () => {
    state.bioWriteErr = { code: "57014", message: "canceling statement due to statement timeout" }
    const body = await (await POST(req({ username: "Rigged" }))).json()
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("skips a Dapper name that cannot become a legal handle", async () => {
    state.resolved = { walletAddress: "0x1111111111111111", username: "edit", dapperId: null }
    const body = await (await POST(req({ username: "edit" }))).json()
    expect(body.profileHandleClaimed).toBe(false)
    expect(state.upserts).toHaveLength(0)
  })
})
