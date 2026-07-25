import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/resend-welcome (POST).
// verifyAdminRequest-gated. Pins the fail-closed 401, invalid-JSON 400, and
// email-required 400 (all resolve before any DB call).

const { ROW } = vi.hoisted(() => ({
  ROW: {
    id: "33333333-3333-3333-3333-333333333333",
    email: "beta@example.com",
    status: "active",
    prewarm_status: "pending",
    prewarm_attempts: 0,
  },
}))
// Three distinct chains hang off allow_list here and each must resolve on its
// own: the fetch (.ilike().maybeSingle()), the reset (.update().eq(), awaited),
// and the force-stamp (.update().eq().select().maybeSingle()). A single shared
// stub can't express that, so dispatch on the op + whether select() was called.
const st = vi.hoisted(() => ({
  fetch: null as any,
  reset: { error: null as any },
  stamp: null as any,
  prewarm: { ok: true } as any,
  prewarmThrows: false,
  finishCalls: [] as any[],
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: any) => {
      if (name === "allow_list_finish_prewarm") st.finishCalls.push(args)
      return { data: null, error: null }
    },
    from() {
      let isUpdate = false
      let selected = false
      const b: any = {
        select: () => { selected = true; return b },
        update: () => { isUpdate = true; return b },
        ilike: () => b,
        eq: (..._a: unknown[]) => {
          // the reset chain is awaited directly off .eq()
          const p: any = Promise.resolve(isUpdate && !selected ? st.reset : { data: null, error: null })
          p.select = () => { selected = true; return b }
          p.maybeSingle = b.maybeSingle
          return p
        },
        maybeSingle: async () => (isUpdate ? st.stamp : st.fetch),
      }
      return b
    },
  },
}))
vi.mock("@/lib/allow-list/prewarm", () => ({
  processSinglePrewarmRow: async () => {
    if (st.prewarmThrows) throw new Error("seeder blew up")
    return st.prewarm
  },
}))

import { POST } from "@/app/api/admin/resend-welcome/route"

const ADMIN = "test-admin-token"

function post(body: unknown, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/resend-welcome", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  st.fetch = { data: ROW, error: null }
  st.reset = { error: null }
  st.stamp = { data: { ...ROW, prewarm_attempts: 1 }, error: null }
  st.prewarm = { ok: true }
  st.prewarmThrows = false
  st.finishCalls = []
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
})

describe("POST /api/admin/resend-welcome", () => {
  it("401s fail-closed when RPC_ADMIN_TOKEN is unset", async () => {
    expect((await POST(post({ email: "a@b.com" }, `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s on invalid JSON", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post("{bad", `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("400s when email is missing or malformed", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ email: "not-an-email" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("email required")
  })

  it("200s reset:true for an authed active row (non-force resets stamps for the cron)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post({ email: "beta@example.com" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.reset).toBe(true)
    expect(body.id).toBe("33333333-3333-3333-3333-333333333333")
  })
})

// --- row lookup, status gate, reset failure, and the force=true inline run ---

describe("POST /api/admin/resend-welcome — row + reset", () => {
  beforeEach(() => { process.env.RPC_ADMIN_TOKEN = ADMIN })

  it("500s when the allow_list lookup errors", async () => {
    st.fetch = { data: null, error: { message: "lookup down" } }
    const res = await POST(post({ email: "beta@example.com" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("lookup down")
  })

  it("404s when no allow_list row matches the email", async () => {
    st.fetch = { data: null, error: null }
    const res = await POST(post({ email: "ghost@example.com" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(404)
  })

  it("400s when the row is not active (only active rows can be re-welcomed)", async () => {
    st.fetch = { data: { ...ROW, status: "revoked" }, error: null }
    const res = await POST(post({ email: "beta@example.com" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain("revoked")
  })

  it("500s when the stamp reset fails", async () => {
    st.reset = { error: { message: "reset down" } }
    const res = await POST(post({ email: "beta@example.com" }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
  })

  it("lower-cases and trims the submitted email before lookup", async () => {
    const res = await POST(post({ email: "  BETA@Example.com  " }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
  })
})

describe("POST /api/admin/resend-welcome — force=true inline run", () => {
  beforeEach(() => { process.env.RPC_ADMIN_TOKEN = ADMIN })

  it("runs the prewarm inline and returns its outcome", async () => {
    st.prewarm = { id: ROW.id, finish_status: "done", welcome_sent: true }
    const res = await POST(post({ email: "beta@example.com", force: true }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.outcome).toMatchObject({ finish_status: "done", welcome_sent: true })
  })

  it("500s when the in_progress stamp errors", async () => {
    st.stamp = { data: null, error: { message: "stamp down" } }
    const res = await POST(post({ email: "beta@example.com", force: true }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("stamp down")
  })

  it("500s 'Row vanished mid-stamp' when the stamp returns no row", async () => {
    st.stamp = { data: null, error: null }
    const res = await POST(post({ email: "beta@example.com", force: true }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Row vanished mid-stamp")
  })

  it("marks the row failed rather than leaving it stuck when the prewarm throws", async () => {
    st.prewarmThrows = true
    const res = await POST(post({ email: "beta@example.com", force: true }, `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("seeder blew up")
    expect(st.finishCalls).toHaveLength(1)
    expect(st.finishCalls[0]).toMatchObject({ p_id: ROW.id, p_status: "failed" })
    expect(String(st.finishCalls[0].p_error)).toContain("resend-welcome: seeder blew up")
  })
})
