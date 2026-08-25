import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/top-moments. Resolves the target
// user from ?ownerKey (0x → saved_wallets, else username → profile_bio) or
// falls back to the session; returns 401 when NEITHER resolves. Pins the
// fail-closed 401 and a mocked username → RPC happy path.

const state: { user: any; single: any; rpc: any } = {
  user: null,
  single: { data: null, error: null },
  rpc: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, limit: () => b,
      maybeSingle: async () => state.single,
      then: (resolve: any) => resolve(state.single),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.rpc }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/top-moments/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.single = { data: null, error: null }
  state.rpc = { data: [], error: null }
})

describe("GET /api/profile/top-moments", () => {
  it("401s when no ownerKey and no session resolve a user (fail-closed)", async () => {
    const res = await GET(req("https://t/api/profile/top-moments"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns moments for a resolved username on the happy path", async () => {
    state.single = { data: { user_id: "u1" }, error: null } // profile_bio lookup
    state.rpc = { data: [{ moment_id: "m1", fmv_usd: 100 }], error: null }
    const res = await GET(req("https://t/api/profile/top-moments?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).moments).toHaveLength(1)
  })

  it("500s when the RPC errors for a resolved user", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: null, error: { message: "db down" } }
    expect((await GET(req("https://t/api/profile/top-moments?ownerKey=trevor"))).status).toBe(500)
  })

  // HONESTY CANON — CLAUDE.md's WORST sub-class, a false claim about the
  // reader's own account. `resolveUserId` used to swallow both lookup errors,
  // so a FAILED read of an explicitly-requested ownerKey fell through to
  // `getCurrentUser()` and the route answered with THE VIEWER'S OWN moments
  // under someone else's key — not an empty answer, a DIFFERENT one.
  it("does not substitute the viewer's own moments when the owner lookup errored", async () => {
    state.user = { id: "viewer-1" }               // a signed-in viewer is present…
    state.single = { data: null, error: { message: "canceling statement due to statement timeout" } }
    state.rpc = { data: [{ moment_id: "viewer-moment", fmv_usd: 1 }], error: null }

    const res = await GET(req("https://t/api/profile/top-moments?ownerKey=someone-else"))

    // …and must NOT be silently answered for.
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("viewer-moment")
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })

  it("does not claim 'Authentication required' out of a failed lookup", async () => {
    // The anon half of the same defect: a database timeout used to render as a
    // 401, sending a signed-out reader to sign in for a problem that is ours.
    state.user = null
    state.single = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/top-moments?ownerKey=trevor"))
    expect(res.status).not.toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain("Authentication required")
  })

  it("an ownerKey that genuinely resolves to nobody still falls back to the session — positive control", async () => {
    // The documented resolution order is preserved. Without this control the
    // two cases above are satisfiable by a route that stopped falling back at
    // all, which would be a different defect.
    state.user = { id: "viewer-1" }
    state.single = { data: null, error: null }     // read OK, no such owner
    state.rpc = { data: [{ moment_id: "viewer-moment", fmv_usd: 1 }], error: null }
    const res = await GET(req("https://t/api/profile/top-moments?ownerKey=nobody"))
    expect(res.status).toBe(200)
    expect((await res.json()).moments).toHaveLength(1)
  })
})
