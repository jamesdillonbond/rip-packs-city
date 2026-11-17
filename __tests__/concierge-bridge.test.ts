import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { conciergeEnabled, conciergeReply } from "@/lib/alerts/concierge-bridge"

// Optional bot-DM → /api/support-chat bridge, gated by ALERTS_BOT_CONCIERGE="1".
// conciergeReply returns null when disabled, on a non-ok response, on a
// non-string / empty reply, or on a thrown error; otherwise the trimmed reply.

const origEnv = { ...process.env }

beforeEach(() => {
  process.env.ALERTS_BOT_CONCIERGE = "1"
  process.env.INGEST_SECRET_TOKEN = "secret-tok"
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env = { ...origEnv }
})

const opts = { sessionId: "bot:123", ownerKey: "0xabc", ownerId: "uid-1" }

describe("conciergeEnabled", () => {
  it("true only when ALERTS_BOT_CONCIERGE === '1'", () => {
    process.env.ALERTS_BOT_CONCIERGE = "1"
    expect(conciergeEnabled()).toBe(true)
    process.env.ALERTS_BOT_CONCIERGE = "0"
    expect(conciergeEnabled()).toBe(false)
    delete process.env.ALERTS_BOT_CONCIERGE
    expect(conciergeEnabled()).toBe(false)
  })
})

describe("conciergeReply", () => {
  it("returns null without fetching when disabled", async () => {
    process.env.ALERTS_BOT_CONCIERGE = "0"
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)
    expect(await conciergeReply("hi", opts)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("posts to support-chat and returns the trimmed reply", async () => {
    let body: any
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        body = JSON.parse(init.body)
        return { ok: true, json: async () => ({ response: "  hello there  " }) }
      }),
    )
    const reply = await conciergeReply("what is FMV?", opts)
    expect(reply).toBe("hello there")
    expect(body.sessionId).toBe("bot:123")
    expect(body.ownerKey).toBe("0xabc")
    expect(body.ownerId).toBe("uid-1")
    expect(body.pageContext).toBe("bot_dm")
  })

  it("truncates the message to 2000 chars", async () => {
    let body: any
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        body = JSON.parse(init.body)
        return { ok: true, json: async () => ({ response: "ok" }) }
      }),
    )
    await conciergeReply("x".repeat(5000), opts)
    expect(body.message).toHaveLength(2000)
  })

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    expect(await conciergeReply("hi", opts)).toBeNull()
  })

  it("returns null when the reply is empty or non-string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ response: "   " }) })))
    expect(await conciergeReply("hi", opts)).toBeNull()

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ response: 42 }) })))
    expect(await conciergeReply("hi", opts)).toBeNull()
  })

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom") }))
    expect(await conciergeReply("hi", opts)).toBeNull()
  })
})
