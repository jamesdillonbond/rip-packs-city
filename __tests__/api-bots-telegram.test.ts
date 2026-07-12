import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/bots/telegram (webhook).
// Every update is authenticated by Telegram's echoed secret-token header
// (X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET), checked before
// any work -> 401 on mismatch (or when the secret is unset). PLUS the 2xx success
// path: a matching secret dispatches the /help command and 200s ok:true; send()
// no-ops (TELEGRAM_USER_BOT_TOKEN unset) so no live Telegram call runs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => ({ ok: true }),
  resolveChannelOwner: async () => null,
  resolveChannelOwnerUsername: async () => null,
}))
vi.mock("@/lib/alerts/soldpacks", () => ({
  resolveWalletForChannel: async () => null,
  getPackReport: async () => null,
  formatPackReportText: () => "",
}))
vi.mock("@/lib/alerts/concierge-bridge", () => ({
  conciergeReply: async () => "",
  conciergeEnabled: () => false,
}))

import { POST } from "@/app/api/bots/telegram/route"

const SECRET = "test-webhook-secret"

function req(secretHeader?: string): NextRequest {
  const headers = new Headers()
  if (secretHeader) headers.set("x-telegram-bot-api-secret-token", secretHeader)
  return new NextRequest("https://t/api/bots/telegram", { method: "POST", headers, body: "{}" })
}

beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET
})
afterEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET
})

describe("POST /api/bots/telegram", () => {
  it("401s without the secret-token header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong secret-token header", async () => {
    expect((await POST(req("wrong"))).status).toBe(401)
  })

  it("401s when the server secret is unset (fail-closed)", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    expect((await POST(req(SECRET))).status).toBe(401)
  })

  it("200s (ok:true) dispatching a /help command when the secret matches", async () => {
    const headers = new Headers()
    headers.set("x-telegram-bot-api-secret-token", SECRET)
    const body = JSON.stringify({
      message: { chat: { id: 1 }, from: { id: 2, username: "u" }, text: "/help" },
    })
    const res = await POST(
      new NextRequest("https://t/api/bots/telegram", { method: "POST", headers, body }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
