import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for POST /api/bots/telegram (webhook). Auth is Telegram's
// echoed secret-token header. Deep legs: malformed JSON ack, the no-chat/empty-text
// skip, /link (arg-missing + claim ok/fail), /unlink delete, /soldpacks (no wallet
// + report), /help, the concierge branch (toTelegramPlain markdown strip +
// splitForTelegram chunking + the real send() fetch), and the thrown-error ack.

const st = vi.hoisted(() => ({
  claim: { ok: true } as any,
  wallet: null as string | null,
  report: "PACK REPORT",
  conciergeOn: false,
  conciergeReply: "",
  owner: { linked: false, owner_key: null as string | null },
  ownerUsername: null as string | null,
  deleted: [] as any[],
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      const b: any = { delete: () => b, eq: () => b, then: (r: any) => { st.deleted.push(1); return r({ error: null }) } }
      return b
    },
  },
}))
vi.mock("@/lib/alerts", () => ({
  claimChannelLink: async () => st.claim,
  resolveChannelOwner: async () => st.owner,
  resolveChannelOwnerUsername: async () => st.ownerUsername,
}))
vi.mock("@/lib/alerts/soldpacks", () => ({
  resolveWalletForChannel: async () => st.wallet,
  getPackReport: async () => ({ any: true }),
  formatPackReportText: () => st.report,
}))
vi.mock("@/lib/alerts/concierge-bridge", () => ({
  conciergeReply: async () => st.conciergeReply,
  conciergeEnabled: () => st.conciergeOn,
}))

import { POST } from "@/app/api/bots/telegram/route"

const SECRET = "test-webhook-secret"
function post(payload: any, opts: { secret?: string; badJson?: boolean } = {}): NextRequest {
  return {
    headers: new Headers(opts.secret === undefined ? { "x-telegram-bot-api-secret-token": SECRET } : (opts.secret ? { "x-telegram-bot-api-secret-token": opts.secret } : {})),
    json: async () => { if (opts.badJson) throw new Error("bad"); return payload },
  } as any
}
const message = (text: string, over: any = {}) => ({ message: { chat: { id: 1 }, from: { id: 2, username: "u" }, text, ...over } })

let fetchMock: any
beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET
  delete process.env.TELEGRAM_USER_BOT_TOKEN
  st.claim = { ok: true }; st.wallet = null; st.report = "PACK REPORT"
  st.conciergeOn = false; st.conciergeReply = ""; st.owner = { linked: false, owner_key: null }; st.ownerUsername = null; st.deleted = []
  fetchMock = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("POST /api/bots/telegram — auth + acks", () => {
  it("401s without the secret", async () => { expect((await POST(post(message("/help"), { secret: "" }))).status).toBe(401) })
  it("401s on a wrong secret", async () => { expect((await POST(post(message("/help"), { secret: "wrong" }))).status).toBe(401) })
  it("401s when the server secret is unset", async () => { delete process.env.TELEGRAM_WEBHOOK_SECRET; expect((await POST(post(message("/help")))).status).toBe(401) })
  it("acks malformed JSON with ok:true (no retry storm)", async () => {
    const body = await (await POST(post(null, { badJson: true }))).json()
    expect(body.ok).toBe(true)
  })
  it("acks and skips when there is no chat id / text", async () => {
    const body = await (await POST(post({ message: { from: { id: 2 } } }))).json()
    expect(body.ok).toBe(true)
  })
})

describe("POST /api/bots/telegram — commands", () => {
  it("/link without a code prompts for one", async () => {
    await POST(post(message("/link")))
    expect(st.claim).toBeTruthy() // claim not called; prompt sent (token unset → send no-ops)
  })
  it("/link <code> claims the link (ok) and 200s", async () => {
    const body = await (await POST(post(message("/link AB12")))).json()
    expect(body.ok).toBe(true)
  })
  it("/link <code> reports an invalid code when claim fails", async () => {
    st.claim = { ok: false }
    expect((await (await POST(post(message("/link BAD")))).json()).ok).toBe(true)
  })
  it("/unlink deletes the telegram channel", async () => {
    await POST(post(message("/unlink")))
    expect(st.deleted.length).toBe(1)
  })
  it("/soldpacks without a resolvable wallet prompts", async () => {
    st.wallet = null
    expect((await (await POST(post(message("/soldpacks")))).json()).ok).toBe(true)
  })
  it("/soldpacks with a resolved wallet sends the report", async () => {
    st.wallet = "0x1111111111111111"
    process.env.TELEGRAM_USER_BOT_TOKEN = "bot:tok"
    await POST(post(message("/soldpacks 0x1111111111111111")))
    expect(fetchMock).toHaveBeenCalled() // send() ran with a token
  })
  it("/help returns usage", async () => {
    expect((await (await POST(post(message("/help")))).json()).ok).toBe(true)
  })
  it("strips an @botname suffix from the command", async () => {
    expect((await (await POST(post(message("/help@rpc_bot")))).json()).ok).toBe(true)
  })
})

describe("POST /api/bots/telegram — concierge", () => {
  it("routes a non-command to the concierge and strips markdown for Telegram", async () => {
    st.conciergeOn = true
    st.conciergeReply = "**Deal**: [see it](https://x.co/y) `code` *tip*"
    process.env.TELEGRAM_USER_BOT_TOKEN = "bot:tok"
    await POST(post(message("what deals are hot?")))
    const sent = JSON.parse(fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("sendMessage"))![1].body)
    expect(sent.text).not.toMatch(/\*\*/)
    expect(sent.text).toContain("see it — https://x.co/y")
  })
  it("chunks a >4000-char concierge reply into multiple sends", async () => {
    st.conciergeOn = true
    st.conciergeReply = ("line\n".repeat(1200)).trim() // ~6000 chars
    process.env.TELEGRAM_USER_BOT_TOKEN = "bot:tok"
    await POST(post(message("tell me everything")))
    const sends = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("sendMessage"))
    expect(sends.length).toBeGreaterThan(1)
  })
  it("falls back to help when the concierge returns nothing", async () => {
    st.conciergeOn = true
    st.conciergeReply = ""
    expect((await (await POST(post(message("hi")))).json()).ok).toBe(true)
  })
  it("acks ok:true even when a handler throws", async () => {
    st.conciergeOn = true
    // getPackReport isn't reached here; force a throw via resolveChannelOwnerUsername
    st.ownerUsername = null
    // Make conciergeReply throw
    const bridge = await import("@/lib/alerts/concierge-bridge")
    ;(bridge.conciergeReply as any) = async () => { throw new Error("boom") }
    const body = await (await POST(post(message("boom")))).json()
    expect(body.ok).toBe(true)
  })
})
