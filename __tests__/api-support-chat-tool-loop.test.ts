import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Phase 1 of the deep-loop fixture layer: drive support-chat's Anthropic
// tool-use loop with a scripted model. Each test sets an ordered script of model
// turns; the handler runs its REAL dispatch (executeTool), tool_result assembly,
// iteration, end_turn text extraction, escalation branch, and MAX_ITERATIONS
// fallback. Assertions target handler-COMPUTED output (escalated flag,
// escalationReason, the finalize() escalation suffix, the too-complex fallback,
// category) — never just that the fixture text echoed back.

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

function post(message: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `tl-${Math.random()}`, ...extra }),
  })
}

function setScript(script: ScriptTurn[]) {
  A.state.script = script
  A.state.cursor = 0
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key"
  setScript([])
})

describe("support-chat tool-use loop (scripted model)", () => {
  it("extracts the final text on an immediate end_turn (single iteration)", async () => {
    setScript([{ text: "Here is your answer." }])
    const res = await POST(post("what is the FMV of 1:2?"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toBe("Here is your answer.")
    expect(body.escalated).toBe(false)
  })

  it("runs a tool_use turn, then extracts the follow-up end_turn text (two iterations)", async () => {
    setScript([
      { tools: [{ name: "get_fmv", input: { edition: "1:2" } }] },
      { text: "The FMV came back." },
    ])
    const res = await POST(post("price check 1:2"))
    expect(res.status).toBe(200)
    const body = await res.json()
    // The loop reached end_turn (not the too-complex fallback) after dispatching
    // the tool — i.e. iteration 2 ran and its text was extracted by the handler.
    expect(body.response).toBe("The FMV came back.")
    expect(body.category).toBeDefined()
  })

  it("sets escalated + escalationReason and appends the DM suffix from the escalate_to_human tool", async () => {
    setScript([
      { tools: [{ name: "escalate_to_human", input: { reason: "user needs a human" } }] },
      { text: "I've flagged this for the team." },
    ])
    const res = await POST(post("I need to talk to a person"))
    expect(res.status).toBe(200)
    const body = await res.json()
    // escalated + reason are set by the handler from the tool_use block...
    expect(body.escalated).toBe(true)
    expect(body.escalationReason).toBe("user needs a human")
    // ...and finalize() appends the DM suffix onto the model's final text.
    expect(body.response).toContain("I've flagged this for the team.")
    expect(body.response).toContain("twitter.com/RipPacksCity")
  })

  it("falls back to the too-complex message when the loop never reaches end_turn (MAX_ITERATIONS)", async () => {
    // Only tool_use turns -> the loop hits its iteration cap without a final text,
    // so finalize() supplies the fallback. 12 covers MAX_ITERATIONS with margin.
    setScript(Array.from({ length: 12 }, () => ({ tools: [{ name: "get_fmv", input: { edition: "1:2" } }] })))
    const res = await POST(post("do a very long chain"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.response).toContain("too complex")
  })
})
