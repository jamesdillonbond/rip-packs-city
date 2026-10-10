import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/subscribe — an ANONYMOUS route, so the
// email in the body is unproven.
// Pre-DB guards, in order:
//   1. req.json() throws → 400 "Invalid JSON"
//   2. missing email / no "@" → 400 "Invalid email"
// Then: a NEW address gets a row + a verification mail; an EXISTING row is never
// rewritten (2026-10-09 — the old upsert let anyone reset another subscriber's
// opt-out, preferences, wallet and unsubscribe token), only re-sent its
// verification mail with its existing token when unverified/unsubscribed and
// past the cooldown.

const db = vi.hoisted(() => ({
  existing: { data: null as any, error: null as any },
  insertError: null as any,
  updateError: null as any,
  inserts: [] as any[],
  updates: [] as any[],
  // the durable anonymous cap (2026-10-10)
  rate: { allowed: true } as { allowed: boolean } | null,
  rateError: null as any,
}))

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    maybeSingle: async () => db.existing,
    insert: async (row: any) => {
      db.inserts.push(row)
      return { error: db.insertError }
    },
    update: (patch: any) => {
      db.updates.push(patch)
      return { eq: async () => ({ error: db.updateError }) }
    },
    rpc: async () => ({ data: db.rate, error: db.rateError }),
  }
  return { supabaseAdmin: b }
})

import { POST } from "@/app/api/subscribe/route"

function post(body: string): NextRequest {
  return new NextRequest("https://t/api/subscribe", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  })
}

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  db.existing = { data: null, error: null }
  db.insertError = null
  db.updateError = null
  db.inserts = []
  db.updates = []
  db.rate = { allowed: true }
  db.rateError = null
  process.env.RESEND_API_KEY = "test-key"
  fetchSpy = vi.fn(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetchSpy)
})
afterEach(() => {
  delete process.env.RESEND_API_KEY
  vi.unstubAllGlobals()
})

const mailedTokens = () =>
  fetchSpy.mock.calls.map((c: any[]) => String(JSON.parse(c[1].body).html).match(/token=([^"&]+)/)?.[1])

describe("POST /api/subscribe — guards", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(post("not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON")
  })

  it("400s on an email without an @", async () => {
    const res = await POST(post(JSON.stringify({ email: "nope" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid email")
  })
})

describe("POST /api/subscribe — a new address", () => {
  it("inserts a row with the body's preferences and mails a verification link", async () => {
    const res = await POST(post(JSON.stringify({ email: "A@B.com", digestWeekly: false, dealAlerts: true })))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0]).toMatchObject({ email: "a@b.com", digest_weekly: false, deal_alerts: true, verified: false })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(mailedTokens()[0]).toBe(db.inserts[0].verification_token)
  })

  it("a concurrent create (23505) leaves the winner's row alone and still answers success", async () => {
    db.insertError = { code: "23505", message: "duplicate key" }
    const res = await POST(post(JSON.stringify({ email: "a@b.com" })))
    expect(res.status).toBe(200)
    expect(db.updates).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("500s without publishing the driver message when the insert errors", async () => {
    db.insertError = { code: "57014", message: "canceling statement due to statement timeout" }
    const res = await POST(post(JSON.stringify({ email: "a@b.com" })))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).not.toContain("canceling statement")
  })

  it("500s when the existence lookup fails — never treats a failed read as 'new'", async () => {
    db.existing = { data: null, error: { message: "timeout" } }
    const res = await POST(post(JSON.stringify({ email: "a@b.com" })))
    expect(res.status).toBe(500)
    expect(db.inserts).toEqual([])
  })
})

describe("POST /api/subscribe — an EXISTING row is never rewritten", () => {
  const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  it("an UNSUBSCRIBED subscriber is not re-opted-in: no field but the cooldown clock moves, and the mail carries the EXISTING token", async () => {
    db.existing = { data: { verified: true, unsubscribed_at: OLD, verification_token: "tok-old", updated_at: OLD }, error: null }
    const res = await POST(post(JSON.stringify({ email: "victim@x.com", digestWeekly: true, walletAddress: "0xattacker00000000" })))
    expect(res.status).toBe(200)
    expect(db.inserts).toEqual([])
    expect(db.updates).toHaveLength(1)
    expect(Object.keys(db.updates[0])).toEqual(["updated_at"])
    expect(mailedTokens()).toEqual(["tok-old"])
  })

  it("an unverified row inside the cooldown gets no second mail and no write", async () => {
    db.existing = { data: { verified: false, unsubscribed_at: null, verification_token: "tok", updated_at: new Date().toISOString() }, error: null }
    await POST(post(JSON.stringify({ email: "a@b.com" })))
    expect(db.updates).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("a verified, subscribed row gets nothing at all — and the response does not reveal it", async () => {
    db.existing = { data: { verified: true, unsubscribed_at: null, verification_token: "tok", updated_at: OLD }, error: null }
    const res = await POST(post(JSON.stringify({ email: "a@b.com", digestWeekly: false })))
    expect(await res.json()).toEqual({ success: true })
    expect(db.updates).toEqual([])
    expect(db.inserts).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// 2026-10-10 anonymous-write audit: every new address got a Resend mail, and an
// existing unverified one every 10 minutes forever, with no durable cap.
describe("POST /api/subscribe — durable caps", () => {
  it("a refused cap sends NOTHING and still answers success (no subscription oracle)", async () => {
    db.rate = { allowed: false }
    const res = await POST(post(JSON.stringify({ email: "victim@example.com" })))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(db.inserts).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("an unreadable counter FAILS CLOSED — no row, no mail", async () => {
    db.rateError = { message: "timeout" }
    const res = await POST(post(JSON.stringify({ email: "a@example.com" })))
    expect(res.status).toBe(503)
    expect(db.inserts).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rejects a non-address email before any write", async () => {
    const res = await POST(post(JSON.stringify({ email: "a@b" })))
    expect(res.status).toBe(400)
  })
})
