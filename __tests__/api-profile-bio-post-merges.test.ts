import { describe, it, expect, beforeEach, vi } from "vitest"

// POST /api/profile/bio MERGES (2026-10-10). It used to upsert the whole row
// with every omitted field as null: /profile/edit never sends favoriteTeam, so
// each save wiped the favorite_team still shown on the public profile, and the
// collection-profile avatar editor (which sends only avatarUrl) would have nulled
// display name, socials and accent and rewritten the username.

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "Trevor.Dillon@example.com" } as any,
  writes: [] as Array<{ method: "update" | "insert" | "upsert"; row: Record<string, unknown> }>,
  updateResult: { data: { username: "trevor" } as unknown, error: null as unknown },
  insertResult: { data: { username: "trevordillon" } as unknown, error: null as unknown },
}))

vi.mock("@/lib/supabase", () => {
  const make = () => {
    let mode: "update" | "insert" | "upsert" | null = null
    const b: any = {}
    for (const m of ["update", "insert", "upsert"] as const) {
      b[m] = (row: Record<string, unknown>) => { mode = m; state.writes.push({ method: m, row }); return b }
    }
    b.eq = () => b
    b.select = () => b
    const res = () => (mode === "insert" ? state.insertResult : state.updateResult)
    b.maybeSingle = async () => res()
    b.single = async () => res()
    return b
  }
  return { supabaseAdmin: { from: () => make() } }
})
vi.mock("@/lib/auth/supabase-server", () => ({ requireUser: async () => state.user }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { POST } from "@/app/api/profile/bio/route"

const req = (body: unknown): any => ({ json: async () => body })

beforeEach(() => {
  state.writes = []
  state.updateResult = { data: { username: "trevor" }, error: null }
  state.insertResult = { data: { username: "trevordillon" }, error: null }
})

describe("POST /api/profile/bio — an existing row is merged, never reset", () => {
  it("an avatar-only save writes ONLY avatar_url (no nulled socials, no username rewrite, no accent reset)", async () => {
    const res = await POST(req({ avatarUrl: "https://x/a.png" }))
    expect(res.status).toBe(200)
    expect(state.writes).toHaveLength(1)
    const w = state.writes[0]
    expect(w.method).toBe("update")
    const { updated_at, ...rest } = w.row
    expect(typeof updated_at).toBe("string")
    expect(rest).toEqual({ avatar_url: "https://x/a.png" })
  })

  it("the /profile/edit payload leaves favorite_team untouched and does not clear the handle on a blank username", async () => {
    await POST(req({ username: null, displayName: "T", tagline: null, twitter: null, discord: null, avatarUrl: null, accentColor: "#123456" }))
    const row = state.writes[0].row
    expect("favorite_team" in row).toBe(false)
    expect("username" in row).toBe(false)
    expect(row).toMatchObject({ display_name: "T", tagline: null, twitter: null, accent_color: "#123456" })
  })

  it("a NEW user's first save gets the email-derived username and the red accent", async () => {
    state.updateResult = { data: null, error: null } // no row yet
    await POST(req({ displayName: "T" }))
    expect(state.writes.map((w) => w.method)).toEqual(["update", "insert"])
    expect(state.writes[1].row).toMatchObject({ user_id: "u1", username: "trevordillon", accent_color: "#E03A2F", display_name: "T" })
  })
})
