import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Streaming (SSE-ish) variant of the support-chat tool loop — the finickiest
// surface, kept to smoke-level frame assertions per the deep-loop doc's
// guardrail: the streamed body must carry (1) the model text chunks, (2) the
// \x1e-delimited JSON meta trailer with handler-computed fields, and (3) the
// canned error message + trailer when the model call dies mid-stream (the
// stream must CLOSE with meta, never hang).

const A = vi.hoisted(() => ({ state: { script: [] as ScriptTurn[], cursor: 0 } }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeSupabaseFixture({}) }))
vi.mock("@anthropic-ai/sdk", async () => {
  const { buildAnthropicClass } = await import("./helpers/anthropic-fixture")
  return { default: buildAnthropicClass(A.state) }
})

const { POST } = await import("@/app/api/support-chat/route")

function post(message: string): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `st-${Math.random()}`, stream: true }),
  })
}

function setScript(script: ScriptTurn[]) {
  A.state.script = script
  A.state.cursor = 0
}

/** Split a streamed body into { text, meta } on the \x1e trailer delimiter. */
async function readStream(res: Response): Promise<{ text: string; meta: Record<string, unknown> }> {
  const raw = await res.text()
  const sep = raw.lastIndexOf("\x1e")
  if (sep === -1) throw new Error(`no meta trailer in streamed body: ${raw.slice(0, 200)}`)
  return { text: raw.slice(0, sep), meta: JSON.parse(raw.slice(sep + 1)) }
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key"
  setScript([])
})

describe("support-chat streaming variant", () => {
  it("streams the model text and closes with the JSON meta trailer", async () => {
    setScript([{ text: "Streamed answer about your moment." }])
    const res = await POST(post("what's my moment worth?"))
    expect(res.status).toBe(200)
    expect(res.headers.get("X-RPC-Stream")).toBe("1")

    const { text, meta } = await readStream(res)
    expect(text).toContain("Streamed answer about your moment.")
    expect(meta).toMatchObject({
      response: "Streamed answer about your moment.",
      escalated: false,
    })
    expect(typeof meta.category).toBe("string")
  })

  it("runs the tool loop under streaming: tool_use iteration then streamed final text", async () => {
    setScript([
      { tools: [{ name: "get_fmv", input: { edition: "1:2" } }] },
      { text: "FMV is $12." },
    ])
    const res = await POST(post("price check 1:2"))
    const { text, meta } = await readStream(res)
    expect(text).toContain("FMV is $12.")
    expect(meta.response).toBe("FMV is $12.")
  })

  it("carries escalation through the streamed meta trailer", async () => {
    setScript([
      { tools: [{ name: "escalate_to_human", input: { reason: "human please" } }] },
      { text: "Flagged for the team." },
    ])
    const res = await POST(post("I want to talk to a person"))
    const { meta } = await readStream(res)
    expect(meta.escalated).toBe(true)
    expect(meta.escalationReason).toBe("human please")
    expect(String(meta.response)).toContain("twitter.com/RipPacksCity")
  })

  it("a mid-stream model failure writes the canned overloaded message and STILL closes with meta", async () => {
    setScript([{ error: { message: "Overloaded", status: 529, type: "overloaded_error" } }])
    const res = await POST(post("hello there, question about packs"))
    // The HTTP response itself is the 200 stream shell; the error surfaces in-band.
    expect(res.status).toBe(200)
    const { text, meta } = await readStream(res)
    expect(text).toContain("AI concierge is having a moment.")
    expect(meta.response).toBe("AI concierge is having a moment. Please try again shortly.")
    expect(meta.category).toBe("concierge_overloaded")
  })
})
