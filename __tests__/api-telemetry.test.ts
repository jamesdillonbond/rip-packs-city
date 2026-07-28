import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/telemetry — the usage_events beacon.
// It NEVER returns a non-204 (telemetry must not surface as a UI error), so the
// interesting behavior is all in what it WRITES: the feature normalization
// (lowercase + non-alnum → _ + 80-char cap), the metadata JSON-safety/truncation
// guard, and the server-side identity resolution (allow_list wallet → user:<id>
// sentinel → "anon"). Captures the usage_events insert payload to assert them.

const state: { user: any; userThrows: boolean; allowRow: any; insert: any } = {
  user: null,
  userThrows: false,
  allowRow: null,
  insert: null,
}

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => {
    if (state.userThrows) throw new Error("auth down")
    return state.user
  },
}))

vi.mock("@/lib/supabase", () => {
  const allowBuilder: any = {
    select: () => allowBuilder,
    ilike: () => allowBuilder,
    limit: () => allowBuilder,
    maybeSingle: async () => ({ data: state.allowRow }),
  }
  return {
    supabaseAdmin: {
      from: (t: string) => {
        if (t === "usage_events") {
          return {
            insert: (payload: any) => {
              state.insert = payload
              return { then: (res: any) => res({ error: null }) }
            },
          }
        }
        return allowBuilder
      },
    },
  }
})

import { POST } from "@/app/api/telemetry/route"

const req = (body: any, isBad = false) =>
  ({ json: async () => { if (isBad) throw new Error("bad json"); return body } }) as any

beforeEach(() => {
  state.user = null
  state.userThrows = false
  state.allowRow = null
  state.insert = null
})

describe("POST /api/telemetry", () => {
  it("204s and writes nothing on an invalid JSON body", async () => {
    const res = await POST(req(null, true))
    expect(res.status).toBe(204)
    expect(state.insert).toBeNull()
  })

  it("204s and writes nothing when feature is missing/blank", async () => {
    expect((await POST(req({}))).status).toBe(204)
    expect((await POST(req({ feature: "   " }))).status).toBe(204)
    expect(state.insert).toBeNull()
  })

  it("normalizes the feature (lowercase, non-alnum → _)", async () => {
    await POST(req({ feature: "  Pack Sniper!!  " }))
    expect(state.insert.feature_name).toBe("pack_sniper__")
  })

  it("caps the feature at 80 chars", async () => {
    await POST(req({ feature: "a".repeat(200) }))
    expect(state.insert.feature_name).toHaveLength(80)
  })

  it("resolves an authed user's wallet from allow_list", async () => {
    state.user = { id: "u1", email: "trevor@x.com" }
    state.allowRow = { wallet_addr: "0xabc" }
    await POST(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("0xabc")
  })

  it("falls back to the user:<id> sentinel when the user has no allow_list wallet", async () => {
    state.user = { id: "u1", email: "trevor@x.com" }
    state.allowRow = null
    await POST(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("user:u1")
  })

  it("uses 'anon' for an unauthenticated caller", async () => {
    state.user = null
    await POST(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("anon")
  })

  it("uses 'anon' when identity resolution throws", async () => {
    state.userThrows = true
    await POST(req({ feature: "view" }))
    expect(state.insert.wallet_address).toBe("anon")
  })

  it("keeps small JSON-safe metadata", async () => {
    await POST(req({ feature: "view", metadata: { tab: "market", n: 3 } }))
    expect(state.insert.metadata).toEqual({ tab: "market", n: 3 })
  })

  it("replaces oversized metadata with a truncation marker", async () => {
    const big = { blob: "x".repeat(5000) }
    await POST(req({ feature: "view", metadata: big }))
    expect(state.insert.metadata._truncated).toBe(true)
    expect(state.insert.metadata._bytes).toBeGreaterThan(4096)
  })

  it("nulls non-object metadata", async () => {
    await POST(req({ feature: "view", metadata: "not-an-object" }))
    expect(state.insert.metadata).toBeNull()
  })
})
