import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/admin/feedback (the sibling test only pins auth). Lists
// support_conversations with status/type/owner/q filters, re-sorts by a
// deterministic STATUS_RANK, and aggregates beta_feedback_stats via buildStats.
// Legs pinned: auth, the query error → 500, the stats error → 500, the CSV filter
// parsing, the q-search branch, the STATUS_RANK ordering, and the buildStats
// open/triaged/wontfix/shipped tallies.

const st = vi.hoisted(() => ({ authed: true, rows: { data: [] as any[], error: null as any }, stats: { data: [] as any[], error: null as any } }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {}
      for (const m of ["select", "not", "in", "eq", "or", "order", "limit"]) b[m] = () => b
      b.then = (resolve: any) => resolve(table === "support_conversations" ? st.rows : st.stats)
      return b
    },
  },
}))

import { GET } from "@/app/api/admin/feedback/route"

const get = (qs = "", auth = "Bearer ok") => ({ url: `https://t/api/admin/feedback${qs}`, nextUrl: new URL(`https://t/api/admin/feedback${qs}`), headers: new Headers(auth ? { authorization: auth } : {}) }) as any
const row = (over: any = {}) => ({ id: "c1", created_at: "2026-07-01", feedback_status: "new", feedback_type: "bug", ...over })

beforeEach(() => {
  st.authed = true
  st.rows = { data: [row()], error: null }
  st.stats = { data: [], error: null }
})

describe("GET /api/admin/feedback", () => {
  it("401 when not an admin", async () => {
    st.authed = false
    expect((await GET(get())).status).toBe(401)
  })
  it("rows query error → 500", async () => {
    st.rows = { data: null, error: { message: "conv down" } }
    expect((await GET(get())).status).toBe(500)
  })
  it("stats query error → 500", async () => {
    st.stats = { data: null, error: { message: "stats down" } }
    expect((await GET(get())).status).toBe(500)
  })
  it("returns rows + stats on the happy path", async () => {
    st.rows = { data: [row()], error: null }
    st.stats = { data: [{ feedback_type: "bug", feedback_status: "new", n: 3, shipped_last_7d: false }], error: null }
    const body = await (await GET(get())).json()
    expect(body.rows).toHaveLength(1)
    expect(body.stats.open_bugs).toBe(3)
    expect(body.stats.total_open).toBe(3)
  })
  it("re-sorts rows by STATUS_RANK (new before shipped)", async () => {
    st.rows = { data: [row({ id: "shipped1", feedback_status: "shipped" }), row({ id: "new1", feedback_status: "new" })], error: null }
    const body = await (await GET(get())).json()
    expect(body.rows.map((r: any) => r.id)).toEqual(["new1", "shipped1"])
  })
  it("valid status/type CSV filters + q search are accepted (branches)", async () => {
    const res = await GET(get("?status=new,reviewed&type=bug,feature_request&owner_key=0xa&q=broken%20thing"))
    expect(res.status).toBe(200)
  })
  it("buildStats tallies open-by-type, triaged, wontfix, and shipped_last_7d", async () => {
    st.stats = {
      data: [
        { feedback_type: "bug", feedback_status: "new", n: 2, shipped_last_7d: false },
        { feedback_type: "feature_request", feedback_status: "in_progress", n: 1, shipped_last_7d: false },
        { feedback_type: "confusion", feedback_status: "reviewed", n: 4, shipped_last_7d: false },
        { feedback_type: "praise", feedback_status: "new", n: 1, shipped_last_7d: false },
        { feedback_type: "general_feedback", feedback_status: "new", n: 5, shipped_last_7d: false },
        { feedback_type: "bug", feedback_status: "wontfix", n: 3, shipped_last_7d: false },
        { feedback_type: "bug", feedback_status: "shipped", n: 2, shipped_last_7d: true },
      ],
      error: null,
    }
    const s = (await (await GET(get())).json()).stats
    expect(s.open_bugs).toBe(2)
    expect(s.open_features).toBe(1)
    expect(s.open_confusion).toBe(4)
    expect(s.open_praise).toBe(1)
    expect(s.open_general).toBe(5)
    expect(s.total_open).toBe(13)
    expect(s.wontfix_total).toBe(3)
    expect(s.shipped_last_7d).toBe(2)
    expect(s.total_triaged).toBe(5) // wontfix 3 + shipped 2
  })
})
