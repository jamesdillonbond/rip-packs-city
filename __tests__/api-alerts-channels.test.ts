import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/channels (notification-channel links).
// requireUser() throws a 401 Response when unauthenticated. Pins the auth guards
// (GET/POST/DELETE) plus the success + branch legs: GET masked list + 500, POST
// invalid-JSON/invalid-channel/no-email/link-fail/email-send/telegram+discord
// deep links, DELETE unlink + guard + 500, and the maskTarget shapes.

const h = vi.hoisted(() => {
  const state: { dbResult: { data: any; error: any } } = { dbResult: { data: [], error: null } }
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    delete: () => sb,
    then: (resolve: any) => resolve(state.dbResult),
  }
  return { sb, state }
})

const auth: { user: any } = { user: null }
const link = { current: { ok: true, code: "CODE123", expires_at: "2026-07-12T00:15:00Z" } as any }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))
vi.mock("@/lib/alerts", () => ({
  isChannel: (c: unknown) => c === "email" || c === "telegram" || c === "discord",
  createChannelLinkCode: async () => link.current,
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!auth.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return auth.user
  },
}))

import { GET, POST, DELETE } from "@/app/api/alerts/channels/route"

function post(body?: any, badJson = false): NextRequest {
  return {
    json: async () => { if (badJson) throw new Error("bad"); return body },
  } as any
}
const del = (qs = "") => ({ nextUrl: new URL(`https://t/api/alerts/channels${qs}`) }) as any

beforeEach(() => {
  auth.user = null
  h.state.dbResult = { data: [], error: null }
  link.current = { ok: true, code: "CODE123", expires_at: "2026-07-12T00:15:00Z" }
  delete process.env.RESEND_API_KEY
  delete process.env.TELEGRAM_USER_BOT_USERNAME
  delete process.env.DISCORD_APPLICATION_ID
})
afterEach(() => vi.unstubAllGlobals())

describe("/api/alerts/channels — auth + GET", () => {
  it("GET 401s when unauthenticated", async () => { expect((await GET()).status).toBe(401) })
  it("POST 401s when unauthenticated", async () => { expect((await POST(post({ channel: "email" }))).status).toBe(401) })
  it("DELETE 401s when unauthenticated", async () => { expect((await DELETE(del("?channel=email"))).status).toBe(401) })

  it("GET 200s with a masked email + telegram list", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.dbResult = {
      data: [
        { channel: "email", channel_user_id: "user@example.com", channel_username: null, verified: true, verified_at: "2026-07-01T00:00:00Z", last_used_at: null },
        { channel: "telegram", channel_user_id: "9988776655", channel_username: "trev", verified: false, verified_at: null, last_used_at: null },
        { channel: "email", channel_user_id: null, channel_username: null, verified: false, verified_at: null, last_used_at: null },
      ],
      error: null,
    }
    const body = await (await GET()).json()
    expect(body.channels).toHaveLength(3)
    expect(body.channels[0].target).toContain("@example.com")
    expect(body.channels[1].target).toBe("••••6655") // telegram last-4
    expect(body.channels[2].target).toBeNull() // null target
  })

  it("GET 500s on a db error", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.dbResult = { data: null, error: { message: "down" } }
    expect((await GET()).status).toBe(500)
  })
})

describe("/api/alerts/channels — POST", () => {
  it("400s on invalid JSON", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    expect((await POST(post({}, true))).status).toBe(400)
  })
  it("400s on an invalid channel", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(post({ channel: "carrier-pigeon" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("channel must be")
  })
  it("400s for an email link when the account has no email", async () => {
    auth.user = { id: "u1", email: "" }
    const res = await POST(post({ channel: "email" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no email/)
  })
  it("500s when createChannelLinkCode fails", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    link.current = { ok: false }
    expect((await POST(post({ channel: "telegram" }))).status).toBe(500)
  })
  it("email link: sends the verify email and returns pending (RESEND set)", async () => {
    auth.user = { id: "u1", email: "A@B.co" }
    process.env.RESEND_API_KEY = "re_123"
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal("fetch", fetchMock)
    const body = await (await POST(post({ channel: "email" }))).json()
    expect(body.pending).toBe(true)
    expect(body.message).toMatch(/a@b\.co/) // lowercased
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it("email link: skips the send when RESEND_API_KEY is missing (still 200)", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const res = await POST(post({ channel: "email" }))
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("telegram link: deep link uses TELEGRAM_USER_BOT_USERNAME when set", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    process.env.TELEGRAM_USER_BOT_USERNAME = "rpc_bot"
    const body = await (await POST(post({ channel: "telegram" }))).json()
    expect(body.code).toBe("CODE123")
    expect(body.deep_link).toContain("t.me/rpc_bot?start=CODE123")
  })
  it("telegram link: null deep link + fallback instruction when bot env unset", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const body = await (await POST(post({ channel: "telegram" }))).json()
    expect(body.deep_link).toBeNull()
    expect(body.instruction).toMatch(/Telegram/)
  })
  it("discord link: oauth deep link when DISCORD_APPLICATION_ID set", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    process.env.DISCORD_APPLICATION_ID = "app99"
    const body = await (await POST(post({ channel: "discord" }))).json()
    expect(body.deep_link).toContain("client_id=app99")
    expect(body.instruction).toMatch(/link code:CODE123/)
  })
})

describe("/api/alerts/channels — DELETE", () => {
  it("400s on an invalid channel", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    expect((await DELETE(del("?channel=nope"))).status).toBe(400)
  })
  it("unlinks the channel and returns ok", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.dbResult = { data: null, error: null }
    const body = await (await DELETE(del("?channel=telegram"))).json()
    expect(body).toEqual({ ok: true })
  })
  it("500s on a delete error", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.dbResult = { data: null, error: { message: "delete down" } }
    expect((await DELETE(del("?channel=telegram"))).status).toBe(500)
  })
})
