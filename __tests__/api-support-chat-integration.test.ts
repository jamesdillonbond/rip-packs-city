import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Dedicated harness for POST /api/support-chat — the concierge route whose body
// sits behind server identity resolution and the Anthropic client. We stub the
// four seams so the handler's pre-LLM branches run without a real LLM call or a
// live session:
//   - next/server after()            -> no-op (defer paper-trail writes)
//   - @/lib/auth/supabase-server     -> a client whose auth.getUser() has no user,
//                                       so deriveIdentity() returns an anonymous
//                                       identity (email/wallet null)
//   - @supabase/supabase-js          -> makeSupabaseFixture (allow_list / logging)
//   - @anthropic-ai/sdk              -> a stub class so `new Anthropic()` needs no
//                                       key; the greeting path never calls it
// This covers the "Message required" 400 and the anonymous greeting fast-path
// (GREETING_RE) that short-circuits before the model — the branches reachable
// without driving the full tool-use loop.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => makeSupabaseFixture({}),
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => {
        throw new Error("Anthropic should not be called on the greeting/guard paths")
      },
      create: async () => {
        throw new Error("Anthropic should not be called on the greeting/guard paths")
      },
    }
  },
}))

const { POST } = await import("@/app/api/support-chat/route")

function post(body: unknown): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key"
})

describe("POST /api/support-chat — guard + greeting branches", () => {
  it("400s when no message is provided", async () => {
    const res = await POST(post({ sessionId: "s1" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Message required")
  })

  it("returns the anonymous greeting without calling the model", async () => {
    const res = await POST(post({ message: "hello", sessionId: "s-greet-1" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.escalated).toBe(false)
    expect(body.response).toContain("Welcome to RPC")
    expect(body.category).toBeDefined()
  })

  it("treats other greeting tokens (hey/gm/sup) as greetings too", async () => {
    for (const [i, g] of ["hey", "gm", "sup"].entries()) {
      const res = await POST(post({ message: g, sessionId: `s-greet-${i}-b` }))
      expect(res.status).toBe(200)
      expect((await res.json()).response).toContain("Welcome to RPC")
    }
  })

  it("does not treat a substantive question as a greeting (would hit the model → guarded)", async () => {
    // A non-greeting message must NOT short-circuit; on this stubbed setup the
    // model seam throws, so we assert the route does not return the greeting.
    const res = await POST(post({ message: "what is the FMV of 1:2?", sessionId: "s-q1" }))
    const body = await res.json().catch(() => ({}))
    expect(body.response ?? "").not.toContain("Welcome to RPC")
  })
})
