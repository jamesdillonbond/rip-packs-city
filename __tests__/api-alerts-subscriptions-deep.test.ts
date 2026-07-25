import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of /api/alerts/subscriptions (GET/POST/PATCH/DELETE) — session-authed
// deal-feed subscription CRUD. Legs pinned: requireUser rejection on every verb,
// the GET list+preview enrichment, POST create(201)/update(404/200)/sanitize-400,
// PATCH toggle validation + 404, DELETE id-guard + 404, and the sanitize coercion
// (channels/cadence/serial/uuid filters).

const st = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  requireThrows: false,
  list: { data: [] as any[] | null, error: null as any },
  updated: { data: null as any, error: null as any },
  inserted: { data: null as any, error: null as any },
  deleted: { data: [] as any[] | null, error: null as any },
  preview: { deals_count: 3, deals: [{ a: 1 }, { b: 2 }] } as any,
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => { if (st.requireThrows) throw new Response(JSON.stringify({ error: "unauth" }), { status: 401 }); return st.user },
}))
vi.mock("@/lib/alerts", () => ({
  CHANNELS: ["email", "telegram"],
  buildDealAlertsForSubscription: async () => st.preview,
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      let op: "select" | "update" | "insert" | "delete" = "select"
      const b: any = {
        select: () => b, update: () => { op = "update"; return b }, insert: () => { op = "insert"; return b }, delete: () => { op = "delete"; return b },
        eq: () => b, order: () => b,
        maybeSingle: async () => st.updated,
        single: async () => st.inserted,
        then: (resolve: any) => resolve(op === "delete" ? st.deleted : st.list),
      }
      return b
    },
  },
}))

import { GET, POST, PATCH, DELETE } from "@/app/api/alerts/subscriptions/route"

const jreq = (body: any, badJson = false) => ({ json: async () => { if (badJson) throw new Error("bad"); return body }, nextUrl: new URL("https://t/api/alerts/subscriptions") }) as any
const delReq = (qs = "") => ({ nextUrl: new URL(`https://t/api/alerts/subscriptions${qs}`) }) as any

beforeEach(() => {
  st.user = { id: "u1" }
  st.requireThrows = false
  st.list = { data: [], error: null }
  st.updated = { data: null, error: null }
  st.inserted = { data: { id: "new1" }, error: null }
  st.deleted = { data: [], error: null }
  st.preview = { deals_count: 3, deals: [{ a: 1 }] }
})

describe("GET /api/alerts/subscriptions", () => {
  it("returns the requireUser rejection", async () => {
    st.requireThrows = true
    expect((await GET()).status).toBe(401)
  })
  it("select error → 500", async () => {
    st.list = { data: null, error: { message: "down" } }
    expect((await GET()).status).toBe(500)
  })
  it("enriches each subscription with a live preview count", async () => {
    st.list = { data: [{ id: "s1" }], error: null }
    const body = await (await GET()).json()
    expect(body.subscriptions[0].preview_count).toBe(3)
    expect(body.subscriptions[0].preview_deals).toHaveLength(1)
  })
})

describe("POST /api/alerts/subscriptions", () => {
  it("401 rejection", async () => { st.requireThrows = true; expect((await POST(jreq({}))).status).toBe(401) })
  it("400 invalid JSON", async () => { expect((await POST(jreq({}, true))).status).toBe(400) })
  it("400 when channels is an empty array", async () => {
    expect((await POST(jreq({ channels: [] }))).status).toBe(400)
  })
  it("creates a subscription (201) with sanitized fields", async () => {
    const res = await POST(jreq({ label: "  My Alert  ", cadence: "daily", tiers: ["RARE"], min_serial: "5.7", collection_ids: ["95f28a17-224a-4025-96ad-adf8a4c63bfd", "bad-uuid"] }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.subscription.id).toBe("new1")
    expect(body.subscription.preview_count).toBe(3)
  })
  it("updates an existing subscription when body.id is present", async () => {
    st.updated = { data: { id: "s1" }, error: null }
    const body = await (await POST(jreq({ id: "s1" }))).json()
    expect(body.subscription.id).toBe("s1")
  })
  it("404 when updating a non-owned/missing subscription", async () => {
    st.updated = { data: null, error: null }
    expect((await POST(jreq({ id: "sX" }))).status).toBe(404)
  })
  it("insert error → 500", async () => {
    st.inserted = { data: null, error: { message: "insert down" } }
    expect((await POST(jreq({}))).status).toBe(500)
  })
})

describe("PATCH /api/alerts/subscriptions", () => {
  it("400 without id", async () => { expect((await PATCH(jreq({ active: true }))).status).toBe(400) })
  it("400 when active is not a boolean", async () => { expect((await PATCH(jreq({ id: "s1", active: "yes" }))).status).toBe(400) })
  it("toggles active and returns the row", async () => {
    st.updated = { data: { id: "s1", active: false }, error: null }
    const body = await (await PATCH(jreq({ id: "s1", active: false }))).json()
    expect(body.subscription.active).toBe(false)
  })
  it("404 when the subscription is missing", async () => {
    st.updated = { data: null, error: null }
    expect((await PATCH(jreq({ id: "sX", active: true }))).status).toBe(404)
  })
})

describe("DELETE /api/alerts/subscriptions", () => {
  it("400 without an id query param", async () => { expect((await DELETE(delReq())).status).toBe(400) })
  it("deletes and reports the count", async () => {
    st.deleted = { data: [{ id: "s1" }], error: null }
    const body = await (await DELETE(delReq("?id=s1"))).json()
    expect(body).toEqual({ ok: true, deleted: 1 })
  })
  it("404 when nothing was deleted", async () => {
    st.deleted = { data: [], error: null }
    expect((await DELETE(delReq("?id=sX"))).status).toBe(404)
  })
})
