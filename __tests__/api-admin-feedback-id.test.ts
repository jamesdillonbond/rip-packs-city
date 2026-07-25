import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/feedback/[id] (PATCH). Admin-gated
// single-row update on support_conversations. Deep legs: the field validators
// (feedback_status enum, admin_note type, duplicate_of shape), the whole
// duplicate-status resolution block (proposed vs existing lookup, existing 500/404,
// null-canonical 400, self-ref 400, target 500/missing 400/ok), the final update
// 500 + not-found 404, and the happy 200. A select()-arg-dispatched mock lets one
// PATCH make up to three distinct maybeSingle reads.

const st = vi.hoisted(() => ({
  existing: { data: { duplicate_of: null as number | null }, error: null as any },
  target: { data: { id: 99 } as any, error: null as any },
  updated: { data: { id: 5, feedback_status: "reviewed" } as any, error: null as any },
}))

vi.mock("@/lib/supabase", () => {
  const make = () => {
    let cols = ""
    let isUpdate = false
    const b: any = {
      from: () => { cols = ""; isUpdate = false; return b }, // reset per query chain
      select: (c: string) => { cols = c; return b },
      update: () => { isUpdate = true; return b },
      eq: () => b,
      maybeSingle: async () => {
        if (isUpdate) return st.updated
        if (cols === "duplicate_of") return st.existing
        return st.target // select("id")
      },
    }
    return b
  }
  return { supabaseAdmin: make() }
})

import { PATCH } from "@/app/api/admin/feedback/[id]/route"

const ADMIN = "test-admin-token"
function patch(body: unknown, auth = `Bearer ${ADMIN}`): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/feedback/5", { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = ADMIN
  st.existing = { data: { duplicate_of: null }, error: null }
  st.target = { data: { id: 99 }, error: null }
  st.updated = { data: { id: 5, feedback_status: "reviewed" }, error: null }
})
afterEach(() => { delete process.env.RPC_ADMIN_TOKEN })

describe("PATCH /api/admin/feedback/[id] — guards", () => {
  it("401s fail-closed when the token is unset", async () => {
    delete process.env.RPC_ADMIN_TOKEN
    expect((await PATCH(patch({ admin_note: "x" }), ctx("5"))).status).toBe(401)
  })
  it("400s on a non-numeric id", async () => {
    expect((await PATCH(patch({ admin_note: "x" }), ctx("abc"))).status).toBe(400)
  })
  it("400s on invalid JSON", async () => {
    expect((await PATCH(patch("{not json"), ctx("5"))).status).toBe(400)
  })
  it("400s when no updatable fields are supplied", async () => {
    expect((await PATCH(patch({}), ctx("5"))).status).toBe(400)
  })
})

describe("PATCH /api/admin/feedback/[id] — field validators", () => {
  it("400s on an out-of-set feedback_status", async () => {
    const res = await PATCH(patch({ feedback_status: "bogus" }), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("feedback_status must be")
  })
  it("400s when admin_note is neither string nor null", async () => {
    expect((await PATCH(patch({ admin_note: 42 }), ctx("5"))).status).toBe(400)
  })
  it("accepts admin_note: null (clears it)", async () => {
    expect((await PATCH(patch({ admin_note: null }), ctx("5"))).status).toBe(200)
  })
  it("400s on a non-positive/non-integer duplicate_of", async () => {
    expect((await PATCH(patch({ duplicate_of: -3 }), ctx("5"))).status).toBe(400)
  })
  it("accepts duplicate_of: null", async () => {
    expect((await PATCH(patch({ duplicate_of: null }), ctx("5"))).status).toBe(200)
  })
})

describe("PATCH /api/admin/feedback/[id] — duplicate-status resolution", () => {
  it("uses a supplied duplicate_of and verifies the target exists", async () => {
    const res = await PATCH(patch({ feedback_status: "duplicate", duplicate_of: 99 }), ctx("5"))
    expect(res.status).toBe(200)
  })
  it("400s when the target row does not exist", async () => {
    st.target = { data: null, error: null }
    const res = await PATCH(patch({ feedback_status: "duplicate", duplicate_of: 77 }), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("does not reference an existing row")
  })
  it("500s when the target lookup errors", async () => {
    st.target = { data: null, error: { message: "target down" } }
    expect((await PATCH(patch({ feedback_status: "duplicate", duplicate_of: 77 }), ctx("5"))).status).toBe(500)
  })
  it("400s self-reference", async () => {
    const res = await PATCH(patch({ feedback_status: "duplicate", duplicate_of: 5 }), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("same row")
  })
  it("falls back to the row's existing duplicate_of when none supplied", async () => {
    st.existing = { data: { duplicate_of: 99 }, error: null } // row already points at 99
    const res = await PATCH(patch({ feedback_status: "duplicate" }), ctx("5"))
    expect(res.status).toBe(200)
  })
  it("400s when neither supplied nor already set", async () => {
    st.existing = { data: { duplicate_of: null }, error: null }
    const res = await PATCH(patch({ feedback_status: "duplicate" }), ctx("5"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("required when feedback_status='duplicate'")
  })
  it("404s when the row being marked duplicate is missing", async () => {
    st.existing = { data: null, error: null }
    expect((await PATCH(patch({ feedback_status: "duplicate" }), ctx("5"))).status).toBe(404)
  })
  it("500s when the existing-row lookup errors", async () => {
    st.existing = { data: null, error: { message: "existing down" } }
    expect((await PATCH(patch({ feedback_status: "duplicate" }), ctx("5"))).status).toBe(500)
  })
})

describe("PATCH /api/admin/feedback/[id] — write result", () => {
  it("200s and returns the updated row", async () => {
    const body = await (await PATCH(patch({ admin_note: "looked into it" }), ctx("5"))).json()
    expect(body.row.id).toBe(5)
  })
  it("500s on an update error", async () => {
    st.updated = { data: null, error: { message: "update down" } }
    expect((await PATCH(patch({ admin_note: "x" }), ctx("5"))).status).toBe(500)
  })
  it("404s when the update matches no row", async () => {
    st.updated = { data: null, error: null }
    expect((await PATCH(patch({ admin_note: "x" }), ctx("5"))).status).toBe(404)
  })
})
