import { describe, it, expect, beforeEach, vi } from "vitest"

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/profile/trophy — the caption write path.
//
// `trophy_moments.note` is the only field on a trophy the collector authors
// themselves. It has been accepted by POST, stored, returned by the slab RPC,
// typed on TrophySlabData and rendered in the trophy-case PDF since the feature
// shipped — and no UI ever set it, so all 16 pinned trophies in production
// carry a null note. `api-profile-trophy.test.ts:114` even asserts the upsert
// writes `note: null`, which is a test pinning the absence of the feature.
//
// The two design decisions worth guarding are both about what PATCH must NOT
// do, so they are asserted directly:
//   • it must not be POST — POST upserts the WHOLE row, so captioning through
//     it would blank the player, tier, art and FMV of the trophy;
//   • it must not upsert — a caption on an empty slot would otherwise conjure a
//     trophy row with no Moment behind it.
// ─────────────────────────────────────────────────────────────────────────────

const state: {
  user: any
  result: any
  lastUpdate: any
  lastFilters: Array<[string, any]>
  upsertCalled: boolean
} = {
  user: null,
  result: { data: null, error: null },
  lastUpdate: null,
  lastFilters: [],
  upsertCalled: false,
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b,
      update: (payload: any) => {
        state.lastUpdate = payload
        return b
      },
      upsert: () => {
        state.upsertCalled = true
        return b
      },
      delete: () => b,
      eq: (col: string, val: any) => {
        state.lastFilters.push([col, val])
        return b
      },
      order: () => b,
      single: async () => state.result,
      maybeSingle: async () => state.result,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { PATCH, MAX_NOTE_LEN } from "@/app/api/profile/trophy/route"

const req = (body?: any) => ({ json: async () => body }) as any
const pinned = (note: string | null) => ({ data: { id: 1, slot: 2, note }, error: null })

beforeEach(() => {
  state.user = { id: "u-1" }
  state.result = pinned(null)
  state.lastUpdate = null
  state.lastFilters = []
  state.upsertCalled = false
})

describe("PATCH /api/profile/trophy — auth + params", () => {
  it("401s when unauthenticated (fail-closed, like every sibling verb)", async () => {
    state.user = null
    expect((await PATCH(req({ slot: 1, note: "hi" }))).status).toBe(401)
  })

  it.each([[0], [7], [-1], [1.5], ["abc"], [null], [undefined], [{}]])(
    "400s on slot %s",
    async (slot) => {
      const res = await PATCH(req({ slot, note: "hi" }))
      expect(res.status).toBe(400)
    },
  )

  it("coerces a numeric string slot rather than rejecting it", async () => {
    // JSON clients legitimately send "2"; `Number(...)` handles it and the
    // integer/range check still holds. Asserted explicitly because my first
    // draft listed "2" among the rejects — a guess about the contract that the
    // code does not make, and the kind of assertion that would push someone to
    // "fix" working leniency.
    expect((await PATCH(req({ slot: "2", note: "hi" }))).status).toBe(200)
  })

  it("accepts every legal slot", async () => {
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      expect((await PATCH(req({ slot, note: "hi" }))).status).toBe(200)
    }
  })

  it("400s when note is not a string", async () => {
    expect((await PATCH(req({ slot: 1, note: 42 }))).status).toBe(400)
    expect((await PATCH(req({ slot: 1, note: { a: 1 } }))).status).toBe(400)
  })

  it("survives an unparseable body instead of throwing", async () => {
    const res = await PATCH({ json: async () => { throw new Error("bad json") } } as any)
    expect(res.status).toBe(400)
  })
})

describe("PATCH /api/profile/trophy — what it writes", () => {
  it("updates ONLY the note", async () => {
    await PATCH(req({ slot: 2, note: "First moment I ever pulled" }))
    // The whole reason this is not a POST: an upsert of the full row would
    // blank every denormalized field on the trophy being captioned.
    expect(state.lastUpdate).toEqual({ note: "First moment I ever pulled" })
    expect(Object.keys(state.lastUpdate)).toHaveLength(1)
  })

  it("never upserts — a caption cannot conjure a trophy", async () => {
    await PATCH(req({ slot: 2, note: "hi" }))
    expect(state.upsertCalled).toBe(false)
  })

  it("scopes the write to the caller's own row", async () => {
    await PATCH(req({ slot: 2, note: "hi" }))
    // Without the user_id filter this is an IDOR: any signed-in user could
    // caption any other collector's trophy by slot number.
    expect(state.lastFilters).toContainEqual(["user_id", "u-1"])
    expect(state.lastFilters).toContainEqual(["slot", 2])
  })

  it("stores NULL, not an empty string, when the caption is cleared", async () => {
    // The slab branches on presence (`slab.note && ...`), so "" would render an
    // empty quoted line under the trophy.
    for (const note of ["", "   ", "\n\t ", null]) {
      state.lastUpdate = null
      await PATCH(req({ slot: 1, note }))
      expect(state.lastUpdate).toEqual({ note: null })
    }
  })

  it("collapses internal whitespace", async () => {
    await PATCH(req({ slot: 1, note: "  my   first\n\npull  " }))
    expect(state.lastUpdate).toEqual({ note: "my first pull" })
  })

  it("rejects a caption over the cap", async () => {
    const res = await PATCH(req({ slot: 1, note: "x".repeat(MAX_NOTE_LEN + 1) }))
    expect(res.status).toBe(400)
    expect(state.lastUpdate).toBeNull()
  })

  it("accepts a caption exactly at the cap", async () => {
    // Off-by-one mirror: a `>=` in the length check would reject a legal one.
    expect((await PATCH(req({ slot: 1, note: "x".repeat(MAX_NOTE_LEN) }))).status).toBe(200)
  })

  it("measures the cap AFTER collapsing, so padding cannot trip it", async () => {
    const res = await PATCH(req({ slot: 1, note: "   " + "x".repeat(MAX_NOTE_LEN) + "   " }))
    expect(res.status).toBe(200)
  })
})

describe("PATCH /api/profile/trophy — outcomes", () => {
  it("404s for a slot with nothing pinned, rather than reporting success", async () => {
    state.result = { data: null, error: null }
    const res = await PATCH(req({ slot: 5, note: "hi" }))
    expect(res.status).toBe(404)
    // The editor branches on this to say "that slot is empty" instead of
    // "couldn't save", which are different problems with different fixes.
    expect((await res.json()).error).toMatch(/empty|pinned/i)
  })

  it("returns the updated row on success", async () => {
    state.result = pinned("my first pull")
    const res = await PATCH(req({ slot: 2, note: "my first pull" }))
    expect(res.status).toBe(200)
    expect((await res.json()).trophy).toMatchObject({ note: "my first pull" })
  })

  it("never publishes the driver's own message on a DB error", async () => {
    state.result = {
      data: null,
      error: { message: "canceling statement due to statement timeout", code: "57014" },
    }
    const res = await PATCH(req({ slot: 1, note: "hi" }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json().catch(() => ({}))
    expect(JSON.stringify(body)).not.toContain("canceling statement")
  })
})
