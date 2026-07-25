import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/teams/follow (GET/POST/DELETE) — the RLS-enforced per-league
// favorite-team toggle. Pins: GET's invalid-input + unauthed → {authed:false} and
// the following true/false compare; POST's body/league/team validation, 401, the
// upsert error → 500 and success; DELETE's validation, 401, delete error → 500 and
// success. Backed by a stubbed session client.

const st = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  sel: { data: null as any },
  upsert: { error: null as any },
  del: { error: null as any },
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    from() {
      let op: "select" | "upsert" | "delete" = "select"
      const b: any = {
        select: () => b, upsert: () => { op = "upsert"; return b }, delete: () => { op = "delete"; return b }, eq: () => b,
        maybeSingle: async () => st.sel,
        then: (resolve: any) => resolve(op === "upsert" ? st.upsert : st.del),
      }
      return b
    },
  }),
}))

import { GET, POST, DELETE } from "@/app/api/teams/follow/route"

const getReq = (qs: string) => ({ nextUrl: new URL(`https://t/api/teams/follow${qs}`) }) as any
const postReq = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body } }) as any

beforeEach(() => {
  st.user = { id: "u1" }
  st.sel = { data: null }
  st.upsert = { error: null }
  st.del = { error: null }
})

describe("GET /api/teams/follow", () => {
  it("invalid league/slug → { authed:false, following:false }", async () => {
    expect(await (await GET(getReq("?league=BAD&slug=x"))).json()).toEqual({ authed: false, following: false })
  })
  it("unauthed → { authed:false }", async () => {
    st.user = null
    expect((await (await GET(getReq("?league=NBA&slug=lakers"))).json()).authed).toBe(false)
  })
  it("authed + matching pick → following:true", async () => {
    st.sel = { data: { team_slug: "lakers" } }
    expect(await (await GET(getReq("?league=NBA&slug=lakers"))).json()).toEqual({ authed: true, following: true })
  })
  it("authed + different pick → following:false", async () => {
    st.sel = { data: { team_slug: "celtics" } }
    expect((await (await GET(getReq("?league=NBA&slug=lakers"))).json()).following).toBe(false)
  })
})

describe("POST /api/teams/follow", () => {
  it("400 invalid JSON", async () => { expect((await POST(postReq({}, true))).status).toBe(400) })
  it("400 invalid league", async () => { expect((await POST(postReq({ league: "BAD", team_slug: "x" }))).status).toBe(400) })
  it("400 missing team_slug", async () => { expect((await POST(postReq({ league: "NBA" }))).status).toBe(400) })
  it("401 unauthed", async () => {
    st.user = null
    expect((await POST(postReq({ league: "NBA", team_slug: "lakers" }))).status).toBe(401)
  })
  it("upsert error → 500", async () => {
    st.upsert = { error: { message: "rls denied" } }
    expect((await POST(postReq({ league: "NBA", team_slug: "lakers" }))).status).toBe(500)
  })
  it("success → { ok:true, following:true }", async () => {
    const body = await (await POST(postReq({ league: "NBA", team_slug: "lakers" }))).json()
    expect(body).toEqual({ ok: true, following: true })
  })
})

describe("DELETE /api/teams/follow", () => {
  it("400 invalid league/slug", async () => { expect((await DELETE(getReq("?league=BAD&slug=x"))).status).toBe(400) })
  it("401 unauthed", async () => {
    st.user = null
    expect((await DELETE(getReq("?league=NBA&slug=lakers"))).status).toBe(401)
  })
  it("delete error → 500", async () => {
    st.del = { error: { message: "boom" } }
    expect((await DELETE(getReq("?league=NBA&slug=lakers"))).status).toBe(500)
  })
  it("success → { ok:true, following:false }", async () => {
    const body = await (await DELETE(getReq("?league=NBA&slug=lakers"))).json()
    expect(body).toEqual({ ok: true, following: false })
  })
})
