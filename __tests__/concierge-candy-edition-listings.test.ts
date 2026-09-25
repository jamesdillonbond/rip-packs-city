// 2026-09-25 — get_edition_listings had no Candy MLB arm, so every Candy listing
// question came back listings_status 'unavailable' and the concierge told a
// collector "the live marketplace check couldn't be reached" — about a book RPC
// holds (candy_listings, the Magic Eden sweep every 3 h). The arm reads asks
// RE-SEEN within 7 h, and refuses to call an edition unlisted when the book
// itself is stale (a stalled sweep is not an empty market).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
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
    body: JSON.stringify({ message: "is an Ohtani listed?", sessionId: `c-${Math.random()}`, collectionId: "candy-mlb" }),
  })
}
function toolResult(): Record<string, any> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}

const EDITION = { id: "ed-ohtani", external_id: "shohei-ohtani", player_name: "Shohei Ohtani", set_name: "2026 MLB Base Series ICONs", tier: "COMMON", circulation_count: 250, collection_id: "candy" }
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

function install(asks: unknown, head: unknown) {
  A.sb = makeInstrumentedSupabaseFixture({
    editions: { data: [EDITION], error: null },
    fmv_current: { data: [{ fmv_usd: 22.29, confidence: "LOW", edition_id: "ed-ohtani" }], error: null },
    // Promise.all issues the per-edition ask read first, then the book-freshness read.
    candy_listings: [asks, head] as never,
  }).fixture
}

beforeEach(() => {
  A.createCalls.length = 0
  A.state.script = [{ tools: [{ name: "get_edition_listings", input: { editionKey: "shohei-ohtani" } }] }, { text: "done" }]
  A.state.cursor = 0
})

describe("get_edition_listings — Candy MLB reads RPC's Magic Eden book", () => {
  it("listed: the cheapest fresh ask is the floor, with a Magic Eden link and the sweep time", async () => {
    install(
      { data: [{ price_usd: 19.5, token_mint: "MintAAA", last_seen_at: ago(1) }, { price_usd: 24, token_mint: "MintBBB", last_seen_at: ago(1) }], error: null },
      { data: [{ last_seen_at: ago(1) }], error: null },
    )
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("listed")
    expect(r.floor_ask).toBe(19.5)
    expect(r.listings_count).toBe(2)
    expect(r.floor_buy_url).toBe("https://magiceden.io/item-details/MintAAA")
    expect(r.listings_note).toContain("Magic Eden")
    expect(r.fmv).toBe(22.29)
  })

  it("none_listed: a fresh book with no ask for this edition is a real answer", async () => {
    install({ data: [], error: null }, { data: [{ last_seen_at: ago(1) }], error: null })
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("none_listed")
    expect(r.floor_ask).toBeNull()
  })

  it("a STALE book (no sweep inside 7 h) is unavailable, never 'none listed'", async () => {
    install({ data: [], error: null }, { data: [{ last_seen_at: ago(10) }], error: null })
    await POST(post())
    const r = toolResult()
    expect(r.listings_status).toBe("unavailable")
    expect(r.listings_note).toMatch(/could NOT reach/)
  })

  it("a FAILED read is unavailable, never 'none listed'", async () => {
    install({ data: null, error: { message: "canceling statement due to statement timeout" } }, { data: [{ last_seen_at: ago(1) }], error: null })
    await POST(post())
    expect(toolResult().listings_status).toBe("unavailable")
  })
})
