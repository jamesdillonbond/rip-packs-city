import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/support-chat (the AI concierge). The
// handler is a large tool-using Claude loop; the cleanly-testable pre-model
// guard is "message required" → 400 (identity is derived best-effort from the
// cookie, which resolves to nulls in-test). Mocks the Anthropic SDK and
// @supabase/supabase-js so the module constructs without network/keys.
// NOTE: the full streamed tool-loop response is out of scope for a route unit
// test; only the pre-model guard is pinned here.

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async () => ({ content: [] }) }
  },
}))
vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b, eq: () => b, ilike: () => b, order: () => b, limit: () => b,
    maybeSingle: async () => ({ data: null }),
    insert: async () => ({ error: null }),
  }
  return { createClient: () => ({ from: () => b, rpc: async () => ({ data: null, error: null }) }) }
})

import { POST } from "@/app/api/support-chat/route"

const req = (body: any) => ({ json: async () => body, headers: new Headers() }) as any

describe("POST /api/support-chat", () => {
  it("is an exported handler function", () => {
    expect(typeof POST).toBe("function")
  })

  it("400s when the message body is empty", async () => {
    const res = await POST(req({ message: "  ", sessionId: "s1" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Message required")
  })
})
