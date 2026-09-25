// 2026-09-25 — the concierge named Candy MLB (Solana) as a Flow collection.
// Asked "What is Rip Packs City?", it answered "a collector intelligence platform
// for Flow blockchain digital collectibles" and listed ⚾ Candy MLB beside the
// five Flow collections. The prompt hand-listed those five as "the major
// collections across the Dapper and Top Shot ecosystem" next to the registry's
// published list, which also carries Candy. Each published label now carries its
// chain when it is not Flow, derived from the registry, and the hand list is gone.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { publishedCollections } from "@/lib/collections"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ system: Array<{ text: string }> }>,
  sb: null as unknown,
}))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
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
  const Base = buildAnthropicClass(A.state) as new () => { messages: { create: (args: unknown) => Promise<unknown>; stream: (args: unknown) => unknown } }
  return {
    default: class {
      messages = (() => {
        const inner = new Base().messages
        return {
          create: async (args: unknown) => {
            A.createCalls.push(args as never)
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

function post(): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "What is Rip Packs City?", sessionId: `c-${Math.random()}` }),
  })
}

beforeEach(() => {
  A.sb = makeInstrumentedSupabaseFixture({}).fixture
  A.createCalls.length = 0
  A.state.script = [{ text: "ok" }]
  A.state.cursor = 0
})

describe("the concierge prompt names each collection's chain", () => {
  it("every published non-Flow collection is labelled with its chain and 'not Flow'", async () => {
    await POST(post())
    const cacheable = A.createCalls[0].system[0].text
    const nonFlow = publishedCollections().filter((c) => c.dbChain && c.dbChain !== "flow")
    // Population check: Candy MLB (Solana) is published today; if that changes the
    // property is vacuous here, so say so rather than pass silently.
    expect(nonFlow.length, "no published non-Flow collection left to exercise").toBeGreaterThan(0)
    for (const c of nonFlow) {
      const line = cacheable.split("\n").find((l) => l.includes(`${c.icon} ${c.label}`))
      expect(line, `${c.label} is not listed`).toBeDefined()
      expect(line!).toContain(`${c.icon} ${c.label} (on `)
      expect(line!).toContain(", not Flow)")
    }
  })

  it("a Flow collection carries no chain suffix (no-change arm)", async () => {
    await POST(post())
    const cacheable = A.createCalls[0].system[0].text
    const ts = publishedCollections().find((c) => c.dbChain === "flow")!
    expect(cacheable).toContain(`${ts.icon} ${ts.label}`)
    expect(cacheable).not.toContain(`${ts.icon} ${ts.label} (on `)
  })

  it("the hand-maintained five-collection list beside the registry is gone", async () => {
    await POST(post())
    expect(A.createCalls[0].system[0].text).not.toContain("the major collections across the Dapper and Top Shot ecosystem")
  })
})
