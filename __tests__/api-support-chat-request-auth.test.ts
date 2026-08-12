import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// The concierge's two CONSTANT-TIME header checks, plus the bot-DM identity
// bridge they gate — the densest uncovered cluster left in support-chat outside
// the tool arms, and the only part of it that is security-bearing.
//
//   isSmokeTestRequest  — X-RPC-Smoke-Test vs SMOKE_TEST_SESSION_TOKEN. Marks a
//     conversation is_smoke_test so synthetic traffic does not pollute the
//     support corpus or the quota accounting.
//   isTrustedBotRequest — X-RPC-Bot-Secret vs INGEST_SECRET_TOKEN *or*
//     CRON_SECRET. This one is the sharp edge: when it validates AND
//     pageContext is "bot_dm", the route TRUSTS `body.ownerId` as the caller's
//     identity. The Telegram/Discord bridge has no auth cookie, so
//     deriveIdentity() can never see the linked user — the header is the only
//     thing standing between "bridge-resolved owner" and "client-supplied
//     owner". If it ever returned true for a wrong/absent secret, any anonymous
//     caller could assert an arbitrary ownerId and read that user's
//     owner-scoped tools.
//
// So the assertions here are mostly NEGATIVE: wrong secret, absent secret,
// length-mismatched secret, unset env, and right-secret-but-wrong-pageContext
// must all fail to confer identity. A positive-only test would pass just as
// happily against `return true`.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  // Work handed to next/server's after(). See the mock below.
  deferred: [] as Promise<unknown>[],
}))

// ⚠ after() must RUN the callback here, not swallow it.
// persistConversation — where identity and the smoke flag actually land — is
// invoked inside after(). The usual `after: () => {}` stub means NOTHING is ever
// persisted, which makes every "must NOT confer identity" assertion in this file
// pass vacuously: no row exists, so no row has the wrong owner_key. Caught
// exactly that way — the negatives were green while the positives failed.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return {
    ...actual,
    after: (fn: () => unknown) => {
      try {
        const r = fn()
        if (r instanceof Promise) A.deferred.push(r.catch(() => {}))
      } catch {
        /* after() work must never throw into the response path */
      }
    },
  }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}))
vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ allowed: true, plan: "pro", daily_limit: 200 }),
  recordFeatureUsage: async () => {},
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () =>
    new Proxy({}, { get: (_t, prop) => (A.sb as Record<PropertyKey, unknown>)[prop] }),
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
            A.createCalls.push(args as { messages: Array<{ role: string; content: unknown }> })
            return inner.create(args)
          },
          stream: inner.stream,
        }
      })()
    },
  }
})

process.env.ANTHROPIC_API_KEY = "test-key"

const { POST } = await import("@/app/api/support-chat/route")

const BOT_SECRET = "bot-secret-value-32-chars-long!!"
const SMOKE_TOKEN = "smoke-token-value-24-chars"
const OWNER_ID = "11111111-1111-1111-1111-111111111111"
// ⚠ TWO different body fields, and they land in different places:
//   body.ownerId  -> userId   (the auth uid)
//   body.ownerKey -> ownerKey (the username, lowercased) — this is what the
//                    persisted row's `owner_key` column carries.
// Asserting owner_key while only sending ownerId is a vacuous test: the column
// is null either way, so every "must not confer identity" case passes for the
// wrong reason. Both are sent below.
const OWNER_KEY = "TrevorHandle"

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures = {}) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  A.sb = spy.fixture
  return spy
}

function post(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body: JSON.stringify({ message: "hello", sessionId: `auth-${Math.random()}`, ...body }),
  })
}

/** Run POST and drain the after() work it scheduled. */
async function send(req: NextRequest) {
  const res = await POST(req)
  await Promise.all(A.deferred.splice(0))
  return res
}

/** The row the route persists — where identity and smoke-flagging land. */
function persisted(spy: ReturnType<typeof install>): Record<string, unknown> | null {
  const writes = spy.writes["support_conversations"] ?? []
  return (writes.at(-1)?.rows?.[0] as Record<string, unknown>) ?? null
}

beforeEach(() => {
  A.createCalls.length = 0
  A.deferred.length = 0
  A.state.script = [{ text: "ok" }]
  A.state.cursor = 0
  process.env.INGEST_SECRET_TOKEN = BOT_SECRET
  process.env.SMOKE_TEST_SESSION_TOKEN = SMOKE_TOKEN
  delete process.env.CRON_SECRET
})

afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
  delete process.env.SMOKE_TEST_SESSION_TOKEN
  delete process.env.CRON_SECRET
  vi.restoreAllMocks()
})

describe("isSmokeTestRequest — flagging synthetic traffic", () => {
  it("flags a request carrying the correct smoke token", async () => {
    const spy = install()
    await send(post({ "x-rpc-smoke-test": SMOKE_TOKEN }))
    expect(persisted(spy)?.is_smoke_test).toBe(true)
  })

  it("does NOT flag a wrong token, a truncated one, or a missing header", async () => {
    const cases: Array<Record<string, string>> = [
      { "x-rpc-smoke-test": "wrong-token-entirely-24chr" }, // same length, wrong bytes
      { "x-rpc-smoke-test": SMOKE_TOKEN.slice(0, 10) }, // length mismatch
      {}, // absent
    ]
    for (const headers of cases) {
      const spy = install()
      await send(post(headers))
      // Mis-flagging real traffic as smoke would quietly drop it from the
      // support corpus and the quota accounting.
      expect(persisted(spy)?.is_smoke_test ?? false).toBe(false)
    }
  })

  it("does not flag when SMOKE_TEST_SESSION_TOKEN is unset", async () => {
    delete process.env.SMOKE_TEST_SESSION_TOKEN
    const spy = install()
    await send(post({ "x-rpc-smoke-test": SMOKE_TOKEN }))
    // An unset expected value must never make every presented value valid.
    expect(persisted(spy)?.is_smoke_test ?? false).toBe(false)
  })
})

describe("isTrustedBotRequest — the bot-DM identity bridge", () => {
  it("accepts a bridge-resolved ownerId when the secret validates on a bot DM", async () => {
    const spy = install()
    await send(
      post({ "x-rpc-bot-secret": BOT_SECRET }, { pageContext: "bot_dm", ownerId: OWNER_ID, ownerKey: OWNER_KEY })
    )
    // ownerKey is lowercased on the way in.
    expect(persisted(spy)?.owner_key).toBe(OWNER_KEY.toLowerCase())
  })

  it("also accepts CRON_SECRET, the documented equivalent server secret", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    process.env.CRON_SECRET = BOT_SECRET
    const spy = install()
    await send(
      post({ "x-rpc-bot-secret": BOT_SECRET }, { pageContext: "bot_dm", ownerId: OWNER_ID, ownerKey: OWNER_KEY })
    )
    // ownerKey is lowercased on the way in.
    expect(persisted(spy)?.owner_key).toBe(OWNER_KEY.toLowerCase())
  })

  it("REFUSES a client-supplied ownerId without a valid secret", async () => {
    // The core invariant. Each of these is an anonymous caller trying to assert
    // someone else's identity; none may confer it.
    const cases: Array<[string, Record<string, string>]> = [
      ["no header at all", {}],
      ["wrong secret of the same length", { "x-rpc-bot-secret": "x".repeat(BOT_SECRET.length) }],
      ["length-mismatched secret", { "x-rpc-bot-secret": "short" }],
      ["empty header", { "x-rpc-bot-secret": "" }],
    ]
    for (const [why, headers] of cases) {
      const spy = install()
      await send(post(headers, { pageContext: "bot_dm", ownerId: OWNER_ID, ownerKey: OWNER_KEY }))
      expect(persisted(spy)?.owner_key ?? null, `${why} must not confer identity`).not.toBe(
        OWNER_KEY.toLowerCase()
      )
    }
  })

  it("refuses when BOTH server secrets are unset", async () => {
    // Otherwise a misconfigured deploy would accept any presented secret.
    delete process.env.INGEST_SECRET_TOKEN
    delete process.env.CRON_SECRET
    const spy = install()
    await send(post({ "x-rpc-bot-secret": BOT_SECRET }, { pageContext: "bot_dm", ownerId: OWNER_ID, ownerKey: OWNER_KEY }))
    expect(persisted(spy)?.owner_key ?? null).not.toBe(OWNER_KEY.toLowerCase())
  })

  it("refuses a valid secret when pageContext is NOT bot_dm", async () => {
    // The secret alone is not enough: the ownerId shortcut exists only for the
    // stateless bridge. Accepting it from a web request would let anything
    // holding the server secret impersonate a user through the widget.
    const spy = install()
    await send(post({ "x-rpc-bot-secret": BOT_SECRET }, { pageContext: "web", ownerId: OWNER_ID, ownerKey: OWNER_KEY }))
    expect(persisted(spy)?.owner_key ?? null).not.toBe(OWNER_KEY.toLowerCase())
  })

  it("ignores a non-string ownerId even with a valid secret", async () => {
    const spy = install()
    await send(
      post({ "x-rpc-bot-secret": BOT_SECRET }, { pageContext: "bot_dm", ownerId: { evil: true }, ownerKey: { evil: true } })
    )
    const key = persisted(spy)?.owner_key ?? null
    expect(typeof key === "string" ? key : null).not.toBe(OWNER_KEY.toLowerCase())
  })
})

describe("persistConversation — a failed write must not fail the reply", () => {
  it("still answers the user when the insert returns an error", async () => {
    install({ support_conversations: { data: null, error: { message: "insert denied" } } })
    const res = await send(post({}))
    // The conversation log is telemetry; losing a row must never cost the user
    // their answer.
    expect(res.status).toBe(200)
  })

  it("still answers the user when the insert THROWS", async () => {
    const spy = makeInstrumentedSupabaseFixture({}, { failWrites: ["support_conversations"] })
    A.sb = spy.fixture
    const res = await send(post({}))
    expect(res.status).toBe(200)
  })
})
