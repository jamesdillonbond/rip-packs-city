import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/admin/beta-activity (the sibling test only pins auth).
// Joins allow_list (active) → auth.admin.listUsers (email→id) → user_profiles
// (last_active) → usage_events (7d page-views + top features), and stitches rows.
// Legs pinned: auth, the allow_list error → 500, the listUsers throw tolerance, the
// event grouping (page-view count / lastSeen / feature tally with page-view
// excluded + top-3 sort), and the empty case.

const st = vi.hoisted(() => ({
  allow: { data: [] as any[], error: null as any },
  users: { data: { users: [] as any[] } } as any,
  usersThrow: false,
  profiles: { data: [] as any[] },
  events: { data: [] as any[] },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b, gte: () => b,
        then: (resolve: any) =>
          resolve(table === "allow_list" ? st.allow : table === "user_profiles" ? st.profiles : table === "usage_events" ? st.events : { data: [] }),
      }
      return b
    },
    auth: { admin: { listUsers: async () => { if (st.usersThrow) throw new Error("listUsers down"); return st.users } } },
  },
}))

import { GET } from "@/app/api/admin/beta-activity/route"

const get = (auth = "Bearer ingest") => ({ headers: new Headers(auth ? { authorization: auth } : {}) }) as any

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  st.allow = { data: [], error: null }
  st.users = { data: { users: [] } }
  st.usersThrow = false
  st.profiles = { data: [] }
  st.events = { data: [] }
})

describe("GET /api/admin/beta-activity", () => {
  it("401 without a valid token", async () => {
    expect((await GET(get("Bearer nope"))).status).toBe(401)
  })
  it("allow_list error → 500", async () => {
    st.allow = { data: null, error: { message: "allow down" } }
    expect((await GET(get())).status).toBe(500)
  })
  it("empty allow_list → user_count 0", async () => {
    const body = await (await GET(get())).json()
    expect(body.user_count).toBe(0)
    expect(body.rows).toEqual([])
  })
  it("stitches allow_list + profile + usage into a row with top features", async () => {
    st.allow = { data: [{ email: "a@x.com", username: "alice", wallet_addr: "0xa", status: "active", approved_at: "2026-01-01" }], error: null }
    st.users = { data: { users: [{ id: "u1", email: "a@x.com" }] } }
    st.profiles = { data: [{ id: "u1", last_active_at: "2026-07-01" }] }
    st.events = {
      data: [
        { wallet_address: "0xa", feature_name: "page-view", occurred_at: "2026-07-20" },
        { wallet_address: "0xa", feature_name: "fmv", occurred_at: "2026-07-22" },
        { wallet_address: "0xa", feature_name: "fmv", occurred_at: "2026-07-21" },
        { wallet_address: "0xa", feature_name: "sniper", occurred_at: "2026-07-19" },
      ],
    }
    const body = await (await GET(get())).json()
    expect(body.user_count).toBe(1)
    const r = body.rows[0]
    expect(r.email).toBe("a@x.com")
    expect(r.last_active_at).toBe("2026-07-01")
    expect(r.page_views_7d).toBe(1)
    expect(r.last_seen_at).toBe("2026-07-22") // max occurred_at
    // page-view excluded, sorted by count desc, top 3
    expect(r.top_features).toEqual([{ feature: "fmv", count: 2 }, { feature: "sniper", count: 1 }])
  })
  it("tolerates a listUsers failure (row still returned with nulls)", async () => {
    st.allow = { data: [{ email: "b@x.com", username: "bob", wallet_addr: null, status: "active", approved_at: "2026-01-01" }], error: null }
    st.usersThrow = true
    const body = await (await GET(get())).json()
    expect(body.user_count).toBe(1)
    expect(body.rows[0].last_active_at).toBeNull()
    expect(body.rows[0].page_views_7d).toBe(0)
  })
  it("falls back to the user:<id> event key when the wallet has no bucket", async () => {
    st.allow = { data: [{ email: "c@x.com", username: "carol", wallet_addr: "0xc", status: "active", approved_at: "2026-01-01" }], error: null }
    st.users = { data: { users: [{ id: "u9", email: "c@x.com" }] } }
    st.events = { data: [{ wallet_address: "user:u9", feature_name: "page-view", occurred_at: "2026-07-20" }] }
    const body = await (await GET(get())).json()
    expect(body.rows[0].page_views_7d).toBe(1) // matched via the user:<id> key
  })
})
