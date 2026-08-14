import { describe, it, expect, beforeEach, vi } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/rewards/equip — taking a cosmetic off.
//
// Equipping was ONE-WAY until 2026-08-13: the route only ever wrote a value and
// no UI cleared one, so a collector who tried a border on could never remove
// it. That is the most basic expectation of a cosmetic, and its absence made
// trying one riskier than it should have been — which is a plausible part of
// why 0 collectors had ever equipped a banner.
// ─────────────────────────────────────────────────────────────────────────────

const state: {
  user: any
  updateErr: any
  updates: any[]
  filters: Array<[string, any]>
  upsertCalled: boolean
} = { user: { id: "u-1" }, updateErr: null, updates: [], filters: [], upsertCalled: false }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      update: (payload: any) => {
        state.updates.push(payload)
        return b
      },
      upsert: () => {
        state.upsertCalled = true
        return Promise.resolve({ error: null })
      },
      eq: (c: string, v: any) => {
        state.filters.push([c, v])
        return b
      },
      then: (resolve: any) => resolve({ error: state.updateErr }),
    }
    return b
  }
  const client: any = { from: () => build() }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return state.user
  },
}))

import { DELETE } from "@/app/api/rewards/equip/route"

const req = (body?: any, throws = false) =>
  ({ json: async () => { if (throws) throw new Error("bad"); return body } }) as any

beforeEach(() => {
  state.user = { id: "u-1" }
  state.updateErr = null
  state.updates = []
  state.filters = []
  state.upsertCalled = false
})

describe("DELETE /api/rewards/equip", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    expect((await DELETE(req({ slot: "border" }))).status).toBe(401)
  })

  it("nulls the border slot", async () => {
    const res = await DELETE(req({ slot: "border" }))
    expect(res.status).toBe(200)
    expect(state.updates[0]).toMatchObject({ equipped_border: null })
  })

  it("nulls the banner slot", async () => {
    await DELETE(req({ slot: "banner" }))
    expect(state.updates[0]).toMatchObject({ equipped_banner: null })
  })

  it("scopes the write to the caller", async () => {
    await DELETE(req({ slot: "border" }))
    expect(state.filters).toContainEqual(["user_id", "u-1"])
  })

  it("does NOT create a profile_bio row", async () => {
    // Unequipping is meaningful only for someone who has a row; upserting one
    // writes a record whose entire content is the absence of a cosmetic.
    await DELETE(req({ slot: "border" }))
    expect(state.upsertCalled).toBe(false)
  })

  it("rejects an unknown slot", async () => {
    expect((await DELETE(req({ slot: "hat" }))).status).toBe(400)
    expect(state.updates).toHaveLength(0)
  })

  it("does not resolve a prototype key to a column name", async () => {
    // `slot` is client-supplied and a bare MAP[slot] read matches inherited
    // Object.prototype members, so "constructor" would be truthy and get
    // spliced into the update as a column.
    for (const slot of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const res = await DELETE(req({ slot }))
      expect(res.status).toBe(400)
    }
    expect(state.updates).toHaveLength(0)
  })

  it("survives an unparseable body", async () => {
    expect((await DELETE(req(undefined, true))).status).toBe(400)
  })

  it("is idempotent — taking off what you are not wearing is not an error", async () => {
    // A 404 here would make the button fail for whoever double-clicked it.
    const res = await DELETE(req({ slot: "border" }))
    expect(res.status).toBe(200)
    expect((await res.json()).value).toBeNull()
  })

  it("never publishes the driver's message on a DB error", async () => {
    state.updateErr = { message: "canceling statement due to statement timeout", code: "57014" }
    const res = await DELETE(req({ slot: "border" }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).not.toContain("canceling statement")
  })
})
