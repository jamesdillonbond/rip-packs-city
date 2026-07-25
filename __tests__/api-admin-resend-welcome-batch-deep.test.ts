import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of POST /api/admin/resend-welcome-batch (the sibling test only pins
// auth). Two modes: an explicit emails[] list or a ?dormant_since_days=N cohort
// (active users who got a welcome but never produced a usage beacon). Legs pinned:
// auth, the no-input 400, the emails-mode happy/fail/throw legs, the dormant-mode
// usage_events filter, the invalid-days 500, and the >50 has_more slice.

const st = vi.hoisted(() => ({
  authed: true,
  allow: { data: [] as any[], error: null as any },
  events: { data: [] as any[], error: null as any },
  outcome: { ok: true } as any,
  outcomeThrows: false,
}))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminRequest: () => st.authed,
  adminUnauthorizedResponse: () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
}))
vi.mock("@/lib/allow-list/prewarm", () => ({
  processSinglePrewarmRow: async () => { if (st.outcomeThrows) throw new Error("prewarm boom"); return st.outcome },
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let op: "select" | "update" = "select"
      const b: any = {
        select: () => b, update: () => { op = "update"; return b },
        in: () => b, eq: () => b, not: () => b, lt: () => b, order: () => b, limit: () => b,
        then: (resolve: any) => {
          if (table === "allow_list") return resolve(op === "update" ? { error: null } : st.allow)
          if (table === "usage_events") return resolve(st.events)
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: async () => ({ data: null, error: null }),
  },
}))

import { POST } from "@/app/api/admin/resend-welcome-batch/route"

const post = (opts: { emails?: string[]; qs?: string } = {}) =>
  ({ url: `https://t/api/admin/resend-welcome-batch${opts.qs ?? ""}`, json: async () => (opts.emails ? { emails: opts.emails } : {}) }) as any
const activeRow = (over: any = {}) => ({ id: "r1", email: "a@x.com", wallet_addr: "0xa", username: "alice", collections: [], status: "active", prewarm_attempts: 0, welcome_email_sent_at: "2026-01-01", ...over })

beforeEach(() => {
  st.authed = true
  st.allow = { data: [activeRow()], error: null }
  st.events = { data: [], error: null }
  st.outcome = { ok: true }
  st.outcomeThrows = false
})

describe("POST /api/admin/resend-welcome-batch", () => {
  it("401 when not an admin", async () => {
    st.authed = false
    expect((await POST(post({ emails: ["a@x.com"] }))).status).toBe(401)
  })
  it("400 when neither emails nor dormant_since_days is provided", async () => {
    expect((await POST(post())).status).toBe(400)
  })
  it("emails mode: processes an active row and reports succeeded", async () => {
    const body = await (await POST(post({ emails: ["a@x.com", "not-an-email"] }))).json()
    expect(body.mode).toBe("emails")
    expect(body.matched).toBe(1)
    expect(body.processed).toBe(1)
    expect(body.succeeded).toBe(1)
    expect(body.failed).toEqual([])
  })
  it("emails mode: a !ok outcome is recorded as a failure", async () => {
    st.outcome = { ok: false, error: "smtp rejected" }
    const body = await (await POST(post({ emails: ["a@x.com"] }))).json()
    expect(body.succeeded).toBe(0)
    expect(body.failed[0]).toMatchObject({ email: "a@x.com", reason: "smtp rejected" })
  })
  it("emails mode: a thrown prewarm is caught into failures", async () => {
    st.outcomeThrows = true
    const body = await (await POST(post({ emails: ["a@x.com"] }))).json()
    expect(body.failed[0].reason).toContain("prewarm boom")
  })
  it("only active allow_list rows are eligible (inactive filtered out)", async () => {
    st.allow = { data: [activeRow(), activeRow({ id: "r2", email: "b@x.com", status: "revoked" })], error: null }
    const body = await (await POST(post({ emails: ["a@x.com", "b@x.com"] }))).json()
    expect(body.matched).toBe(1) // only the active one
  })
  it("dormant mode: usage_events filters out wallets with a beacon", async () => {
    st.allow = { data: [activeRow({ id: "r1", wallet_addr: "0xseen" }), activeRow({ id: "r2", email: "c@x.com", wallet_addr: "0xunseen" })], error: null }
    st.events = { data: [{ wallet_address: "0xseen" }] } // 0xseen has telemetry → excluded
    const body = await (await POST(post({ qs: "?dormant_since_days=7" }))).json()
    expect(body.mode).toBe("dormant")
    expect(body.matched).toBe(1) // only 0xunseen remains
    expect(body.dormant_since_days).toBeUndefined // not on the response body (it's in extra)
  })
  it("dormant mode: an invalid days value → 500", async () => {
    expect((await POST(post({ qs: "?dormant_since_days=0" }))).status).toBe(500)
  })
  it(">50 candidates → has_more true and the batch is capped at 50", async () => {
    st.allow = { data: Array.from({ length: 60 }, (_, i) => activeRow({ id: `r${i}`, email: `u${i}@x.com` })), error: null }
    const body = await (await POST(post({ emails: Array.from({ length: 60 }, (_, i) => `u${i}@x.com`) }))).json()
    expect(body.has_more).toBe(true)
    expect(body.processed).toBe(50)
  })
})
