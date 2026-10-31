import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/players/follow (2026-10-31) — follow a player (webz_80's 10-27 request, feedback
// 11800). Pins: anon/invalid reads answer {authed:false}; a failed status read is a
// 5xx, never {following:false}; POST validates the slug, 401s anon, refuses a slug that
// names no player hub (404) and a hub read that FAILED (503 — never a follow of an
// unverified slug), maps the 50-player trigger to 409, and stores the hub's name.

const st = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  sel: { data: null as any, error: null as any },
  list: { data: [] as any, error: null as any },
  upsert: { error: null as any },
  del: { error: null as any },
  upserted: null as any,
  hub: { hub: { slug: "nikola-jokic", canonical_slug: "nikola-jokic", name: "Nikola Jokić", collections: [] } as any, ok: true },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    from() {
      let op: "select" | "upsert" | "delete" = "select"
      const b: any = {
        select: () => b,
        upsert: (row: any) => { op = "upsert"; st.upserted = row; return b },
        delete: () => { op = "delete"; return b },
        eq: () => b, order: () => b,
        limit: async () => st.list,
        maybeSingle: async () => st.sel,
        then: (resolve: any) => resolve(op === "upsert" ? st.upsert : st.del),
      }
      return b
    },
  }),
}))
vi.mock("@/lib/player-hub", async (orig) => {
  const actual = await orig<typeof import("@/lib/player-hub")>()
  return { ...actual, fetchPlayerHub: async () => st.hub }
})

import { GET, POST, DELETE } from "@/app/api/players/follow/route"

const getReq = (qs: string) => ({ nextUrl: new URL(`https://t/api/players/follow${qs}`) }) as any
const postReq = (body: any, bad = false) => ({ json: async () => { if (bad) throw new Error("bad"); return body } }) as any

beforeEach(() => {
  st.user = { id: "u1" }
  st.sel = { data: null, error: null }
  st.list = { data: [], error: null }
  st.upsert = { error: null }
  st.del = { error: null }
  st.upserted = null
  st.hub = { hub: { slug: "nikola-jokic", canonical_slug: "nikola-jokic", name: "Nikola Jokić", collections: [] }, ok: true }
})

describe("GET /api/players/follow", () => {
  it("an invalid slug or a signed-out caller reads as not authed", async () => {
    expect(await (await GET(getReq("?slug=%%%"))).json()).toEqual({ authed: false, following: false })
    st.user = null
    expect(await (await GET(getReq("?slug=nikola-jokic"))).json()).toEqual({ authed: false, following: false })
    expect(await (await GET(getReq(""))).json()).toEqual({ authed: false, players: [] })
  })
  it("following reflects the row", async () => {
    st.sel = { data: { player_slug: "nikola-jokic" }, error: null }
    expect(await (await GET(getReq("?slug=nikola-jokic"))).json()).toEqual({ authed: true, following: true })
    st.sel = { data: null, error: null }
    expect((await (await GET(getReq("?slug=nikola-jokic"))).json()).following).toBe(false)
  })
  it("a FAILED status read is an error response, never {following:false}", async () => {
    st.sel = { data: null, error: { message: "boom" } }
    const res = await GET(getReq("?slug=nikola-jokic"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).following).toBeUndefined()
  })
  it("the list form returns slug + name", async () => {
    st.list = { data: [{ player_slug: "nikola-jokic", display_name: "Nikola Jokić", created_at: "2026-10-31T00:00:00Z" }], error: null }
    expect((await (await GET(getReq(""))).json()).players).toEqual([{ slug: "nikola-jokic", name: "Nikola Jokić", followed_at: "2026-10-31T00:00:00Z" }])
  })
})

describe("POST /api/players/follow", () => {
  it("validates the body and requires sign-in", async () => {
    expect((await POST(postReq(null, true))).status).toBe(400)
    expect((await POST(postReq({ slug: "" }))).status).toBe(400)
    expect((await POST(postReq({ slug: "../x" }))).status).toBe(400)
    st.user = null
    expect((await POST(postReq({ slug: "nikola-jokic" }))).status).toBe(401)
  })
  it("refuses a slug that names no player, and a hub read that failed", async () => {
    st.hub = { hub: null, ok: true }
    expect((await POST(postReq({ slug: "nobody-here" }))).status).toBe(404)
    st.hub = { hub: null, ok: false }
    expect((await POST(postReq({ slug: "nikola-jokic" }))).status).toBe(503)
    expect(st.upserted).toBeNull()
  })
  it("stores the slug and the hub's name", async () => {
    const res = await POST(postReq({ slug: "nikola-jokic" }))
    expect(res.status).toBe(200)
    expect(st.upserted).toEqual({ user_id: "u1", player_slug: "nikola-jokic", display_name: "Nikola Jokić" })
  })
  it("maps the 50-player cap (check_violation) to 409", async () => {
    st.upsert = { error: { code: "23514", message: "favorite player limit reached (50)" } }
    expect((await POST(postReq({ slug: "nikola-jokic" }))).status).toBe(409)
  })
})

describe("DELETE /api/players/follow", () => {
  it("validates, requires sign-in, and unfollows", async () => {
    expect((await DELETE(getReq("?slug="))).status).toBe(400)
    st.user = null
    expect((await DELETE(getReq("?slug=nikola-jokic"))).status).toBe(401)
    st.user = { id: "u1" }
    expect(await (await DELETE(getReq("?slug=nikola-jokic"))).json()).toEqual({ ok: true, following: false })
  })
})
