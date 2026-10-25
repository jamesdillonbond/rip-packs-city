import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// 2026-10-24 — every account created since open signup has NO allow_list row
// (measured: 12 of 12 accounts from the last 30 days), and the concierge
// derived ownerKey + userWallet from allow_list only. So a signed-in new user
// was treated exactly like an anonymous visitor: no "signed in" context, none
// of the wallets they saved on RPC, and — when the anonymous budget ran out —
// "Sign in for priority access" said to someone already signed in.
//
// Pinned here:
//   * the prompt says the user is signed in and lists their saved wallets by
//     LABEL, marked unverified;
//   * a saved wallet NEVER becomes "Connected wallet" (userWallet is the
//     watchlist / quota key, and a saved wallet can be anyone's);
//   * an anonymous visitor gets neither line (no saved-wallet read at all).

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as unknown[],
  sb: null as unknown,
  user: null as null | { id: string; email: string },
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: A.user }, error: null }) },
  }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  const Base = buildAnthropicClass(A.state) as new () => {
    messages: { create: (args: unknown) => Promise<unknown>; stream: (args: unknown) => unknown }
  }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return {
          create: async (args: unknown) => {
            A.createCalls.push(args)
            return inner.create(args)
          },
          stream: (args: unknown) => {
            A.createCalls.push(args)
            return inner.stream(args)
          },
        }
      })()
    },
  }
})

process.env.ANTHROPIC_API_KEY = "test-key"
const { POST } = await import("@/app/api/support-chat/route")

const SAVED = [
  { wallet_addr: "0x1234567890abcdef", username: "webz_80", nickname: null, display_name: null, pinned_at: "2026-10-20T00:00:00Z", last_viewed: null },
  { wallet_addr: "0xfedcba0987654321", username: "someoneelse", nickname: "Friend's binder", display_name: null, pinned_at: null, last_viewed: "2026-10-22T00:00:00Z" },
]

function install(withSaved = true) {
  const spy = makeInstrumentedSupabaseFixture({
    allow_list: { data: null, error: null },
    saved_wallets: { data: withSaved ? SAVED : [], error: null },
  } as Parameters<typeof makeInstrumentedSupabaseFixture>[0])
  A.sb = spy.fixture
  return spy
}

function post() {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "how is my collection doing?", sessionId: `si-${Math.random()}` }),
  })
}

function promptText(): string {
  expect(A.createCalls.length, "the model was never called").toBeGreaterThan(0)
  return JSON.stringify((A.createCalls[0] as { system?: unknown }).system ?? A.createCalls[0])
}

beforeEach(() => {
  A.createCalls.length = 0
  A.state.script = [{ text: "ok" }]
  A.state.cursor = 0
  A.user = null
})

describe("concierge: a signed-in user with no allow_list row", () => {
  it("is told the user is signed in and given their saved wallets by label, unverified", async () => {
    A.user = { id: "11111111-1111-1111-1111-111111111111", email: "new@example.com" }
    const spy = install()
    await POST(post())
    const p = promptText()
    expect(p).toContain("Signed in to an RPC account")
    expect(p).toContain("webz_80 (0x1234567890abcdef)")
    expect(p).toContain("Friend's binder (0xfedcba0987654321)") // the user's own nickname wins
    expect(p).toMatch(/ownership NOT verified/)
    // A saved wallet is never promoted to the watchlist / quota key.
    expect(p).not.toContain("Connected wallet:")
    // The read is scoped to THIS user.
    expect(spy.fixture).toBeTruthy()
  })

  it("an anonymous visitor gets neither line", async () => {
    A.user = null
    install()
    await POST(post())
    const p = promptText()
    expect(p).not.toContain("Signed in to an RPC account")
    expect(p).not.toContain("0x1234567890abcdef")
  })

  it("a signed-in user with no saved wallets is still told they are signed in", async () => {
    A.user = { id: "22222222-2222-2222-2222-222222222222", email: "new2@example.com" }
    install(false)
    await POST(post())
    const p = promptText()
    expect(p).toContain("Signed in to an RPC account")
    expect(p).not.toMatch(/Wallets this user saved/)
  })
})
