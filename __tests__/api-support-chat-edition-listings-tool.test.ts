import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute, type FetchStub } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge coverage for `get_edition_listings` — the tool added because the
// bot had NO way to answer "what's the cheapest one listed right now?" about a
// named edition. Every other listing tool is a DEAL board gated on a discount
// below FMV, so an edition listed at or above FMV returns nothing from all of
// them, and the assistant read that emptiness as a market fact. What a real
// user got was: "it's not showing a current listing in the live feed — meaning
// nothing may be listed right now, or it's priced above the feed's current
// snapshot" — our indexing narrated back at them instead of an answer.
//
// The assertions are weighted to the honesty properties, because those are what
// a regression destroys quietly:
//
//  * listings_status must come from the TRANSPORT flag (`ok`), never from the
//    row count. Deriving it from the count re-creates the original bug, where a
//    failed lookup and an empty order book are byte-identical.
//  * an `unavailable` result must never carry a floor, and must never let fmv
//    stand in as a price — fmv is a modelled estimate, not an ask.
//  * an ambiguous name must return CANDIDATES, not a silently-picked first row:
//    attaching a real floor to the wrong moment is worse than asking.

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
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
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

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  A.sb = makeInstrumentedSupabaseFixture(fixtures).fixture
}
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const blocks = secondCall?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result in the follow-up model call")
  return JSON.parse(tr.content)
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  install({})
  A.createCalls.length = 0
})

const LILLARD = {
  external_id: "48:1652",
  player_name: "Damian Lillard",
  set_name: "Archive Set",
  tier: "COMMON",
  circulation_count: 10000,
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
}

async function drive(input: unknown, fixtures: Fixtures, stubs: FetchStub[] = []) {
  install(fixtures)
  if (stubs.length) fetchMock = installFetchMock(stubs)
  A.state.script = [{ tools: [{ name: "get_edition_listings", input }] }, { text: "done" }]
  A.state.cursor = 0
  await POST(
    new NextRequest("https://t/api/support-chat", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        message: "cheapest one listed?",
        sessionId: `el-${Math.random()}`,
        collectionId: "nba-top-shot",
      }),
    }),
  )
  return toolResult()
}

describe("get_edition_listings — availability is a three-way answer", () => {
  it("reports a live floor as 'listed' with a discount and an edition link", async () => {
    const out = await drive(
      { editionKey: "48:1652" },
      {
        editions: { data: [LILLARD], error: null },
        fmv_current: { data: [{ fmv_usd: 4, confidence: "MEDIUM" }], error: null },
        topshot_active_listings: { data: [], error: null },
      },
      [jsonRoute("/api/edition-floor", { ok: true, topShotFloor: 3, topShotListingCount: 12, fetchedAt: "T" })],
    )
    expect(out.status).toBe("ok")
    expect(out.listings_status).toBe("listed")
    expect(out.floor_ask).toBe(3)
    expect(out.listings_count).toBe(12)
    expect(out.discount_pct).toBe(25)
    expect(out.edition_url).toContain("/nba-top-shot/edition/48%3A1652")
  })

  it("reports an empty order book as 'none_listed' — a real answer about the market", async () => {
    const out = await drive(
      { editionKey: "48:1652" },
      {
        editions: { data: [LILLARD], error: null },
        fmv_current: { data: [{ fmv_usd: 4, confidence: "MEDIUM" }], error: null },
        topshot_active_listings: { data: [], error: null },
      },
      [jsonRoute("/api/edition-floor", { ok: true, topShotFloor: null, topShotListingCount: 0 })],
    )
    expect(out.listings_status).toBe("none_listed")
    expect(String(out.listings_note)).toMatch(/NO live asks/i)
  })

  it("reports a FAILED lookup as 'unavailable' and withholds every price-shaped field", async () => {
    // The regression that produced the bad user-facing answer. A 503 from the
    // floor route must NOT read as "nothing is listed".
    const out = await drive(
      { editionKey: "48:1652" },
      {
        editions: { data: [LILLARD], error: null },
        fmv_current: { data: [{ fmv_usd: 4, confidence: "MEDIUM" }], error: null },
        topshot_active_listings: { data: [], error: null },
      },
      [jsonRoute("/api/edition-floor", { ok: false, code: "floor_unavailable" }, { status: 503 })],
    )
    expect(out.listings_status).toBe("unavailable")
    expect(out.floor_ask).toBeNull()
    expect(out.listings_count).toBeNull()
    expect(out.discount_pct).toBeNull()
    expect(String(out.listings_note)).toMatch(/do NOT say nothing is listed/i)
    // FMV still travels (it is a real catalog fact) but is explicitly fenced
    // off from being quoted as a listing price.
    expect(out.fmv).toBe(4)
    expect(String(out.fmv_note)).toMatch(/NOT an ask/i)
  })

  it("treats a 200 whose ok flag is false as unavailable, not as an empty book", async () => {
    // ⚠ The status must come from the transport flag, never from the counts.
    // This body has ok:false with zero rows — deriving status from the row
    // count alone would call it 'none_listed' and the guard would be dead.
    const out = await drive(
      { editionKey: "48:1652" },
      { editions: { data: [LILLARD], error: null }, fmv_current: { data: [], error: null }, topshot_active_listings: { data: [], error: null } },
      [jsonRoute("/api/edition-floor", { ok: false, topShotFloor: null, topShotListingCount: 0 })],
    )
    expect(out.listings_status).toBe("unavailable")
  })

  it("does not present a stale floor arriving alongside ok:false", async () => {
    const out = await drive(
      { editionKey: "48:1652" },
      { editions: { data: [LILLARD], error: null }, fmv_current: { data: [], error: null }, topshot_active_listings: { data: [], error: null } },
      [jsonRoute("/api/edition-floor", { ok: false, topShotFloor: 99, topShotListingCount: 4 })],
    )
    expect(out.listings_status).toBe("unavailable")
    expect(out.floor_ask).toBeNull()
    expect(out.listings_count).toBeNull()
  })
})

describe("get_edition_listings — resolution", () => {
  it("returns candidates rather than silently picking one when the name is ambiguous", async () => {
    const out = await drive(
      { playerName: "Damian Lillard" },
      {
        editions: {
          data: [LILLARD, { ...LILLARD, external_id: "121:4255", set_name: "Run It Back: Legacies", tier: "LEGENDARY" }],
          error: null,
        },
      },
    )
    expect(out.status).toBe("ambiguous")
    expect((out.candidates as unknown[]).length).toBe(2)
    // No floor may be attached to an unresolved edition.
    expect(out.floor_ask).toBeUndefined()
  })

  it("a catalog miss is labelled as a catalog miss, not as an unlisted edition", async () => {
    const out = await drive({ playerName: "Nobody At All" }, { editions: { data: [], error: null } })
    expect(out.status).toBe("no_results")
    expect(String(out.message)).toMatch(/CATALOG miss/i)
    expect(String(out.message)).toMatch(/do not say it isn't listed/i)
  })

  it("a database error stays an error and never degrades to no_results", async () => {
    const out = await drive(
      { editionKey: "48:1652" },
      { editions: { data: null, error: { message: "canceling statement due to statement timeout" } } },
    )
    expect(out.status).toBe("error")
    // The driver's own words must not reach the model verbatim.
    expect(JSON.stringify(out)).not.toMatch(/canceling statement/i)
  })

  it("surfaces a listed chase serial with its own buy link", async () => {
    const out = await drive(
      { editionKey: "48:1652" },
      {
        editions: { data: [LILLARD], error: null },
        fmv_current: { data: [{ fmv_usd: 4, confidence: "MEDIUM" }], error: null },
        topshot_active_listings: {
          data: [{ serial_number: 1, nft_id: "999", ask_usd: "50", serial_fmv_usd: "80", edition_key: "48:1652" }],
          error: null,
        },
      },
      [jsonRoute("/api/edition-floor", { ok: true, topShotFloor: 3, topShotListingCount: 12 })],
    )
    const serials = out.special_serials_listed as Array<Record<string, unknown>>
    expect(serials).toHaveLength(1)
    expect(serials[0].is_first_mint).toBe(true)
    expect(serials[0].buy_url).toBe("https://nbatopshot.com/moment/999")
  })

  it("says an empty serial feed is not evidence the edition is unlisted", async () => {
    // The serial feed covers chase serials only and refreshes every few hours;
    // reading its emptiness as "nothing for sale" is the same conflation one
    // layer down.
    const out = await drive(
      { editionKey: "48:1652" },
      {
        editions: { data: [LILLARD], error: null },
        fmv_current: { data: [], error: null },
        topshot_active_listings: { data: [], error: null },
      },
      [jsonRoute("/api/edition-floor", { ok: true, topShotFloor: 3, topShotListingCount: 12 })],
    )
    expect(String(out.special_serials_note)).toMatch(/not the full order book|NOT the full order book/i)
  })
})

describe("get_edition_listings — collections beyond Top Shot", () => {
  const ALLDAY = {
    id: "ed-uuid-1",
    external_id: "12345",
    player_name: "Patrick Mahomes",
    set_name: "Base",
    tier: "COMMON",
    circulation_count: 5000,
    collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070",
  }

  async function driveAllDay(fixtures: Fixtures) {
    install(fixtures)
    A.state.script = [{ tools: [{ name: "get_edition_listings", input: { editionKey: "12345" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(
      new NextRequest("https://t/api/support-chat", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "cheapest?", sessionId: `ad-${Math.random()}`, collectionId: "nfl-all-day" }),
      }),
    )
    return toolResult()
  }

  it("reads the All Day floor from the on-chain listing index, with a buy link", async () => {
    const out = await driveAllDay({
      editions: { data: [ALLDAY], error: null },
      fmv_current: { data: [{ fmv_usd: 40, confidence: "HIGH" }], error: null },
      allday_edition_floor_ask: {
        data: [{ floor_ask: "25.5", floor_ask_listed_at: "2026-08-15T10:00:00Z", floor_flow_id: 777 }],
        error: null,
      },
    })
    expect(out.listings_status).toBe("listed")
    expect(out.floor_ask).toBe(25.5)
    expect(out.floor_buy_url).toBe("https://nflallday.com/moments/777")
    expect(out.floor_listed_at).toBe("2026-08-15T10:00:00Z")
    expect(out.discount_pct).toBe(36.3)
    // The view carries no depth count; 0 beside a real floor would read as
    // "zero listings" and contradict it.
    expect(out.listings_count).toBeNull()
    expect(String(out.listings_note)).toMatch(/on-chain listing index/i)
  })

  it("treats an empty index row as no open ask, not as a failed check", async () => {
    const out = await driveAllDay({
      editions: { data: [ALLDAY], error: null },
      fmv_current: { data: [], error: null },
      allday_edition_floor_ask: { data: [], error: null },
    })
    expect(out.listings_status).toBe("none_listed")
  })

  it("treats an index ERROR as unavailable, not as no open ask", async () => {
    // supabase-js returns errors rather than throwing, so branching on the row
    // alone would turn a statement timeout into "nothing is listed".
    const out = await driveAllDay({
      editions: { data: [ALLDAY], error: null },
      fmv_current: { data: [], error: null },
      allday_edition_floor_ask: { data: null, error: { message: "canceling statement due to statement timeout" } },
    })
    expect(out.listings_status).toBe("unavailable")
    expect(out.floor_ask).toBeNull()
    expect(String(out.listings_note)).toMatch(/do NOT say nothing is listed/i)
  })

  it("states that UFC's market is CLOSED rather than that the check failed", async () => {
    install({
      editions: {
        data: [{ ...ALLDAY, collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023" }],
        error: null,
      },
      fmv_current: { data: [{ fmv_usd: 12, confidence: "STALE" }], error: null },
    })
    A.state.script = [{ tools: [{ name: "get_edition_listings", input: { editionKey: "12345" } }] }, { text: "done" }]
    A.state.cursor = 0
    await POST(
      new NextRequest("https://t/api/support-chat", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({ message: "cheapest?", sessionId: `ufc-${Math.random()}`, collectionId: "ufc" }),
      }),
    )
    const out = toolResult()
    expect((out.market_closed as Record<string, unknown>).closed_on).toBe("2026-05-13")
    expect(String(out.listings_note)).toMatch(/market is closed/i)
    // Must NOT read as an outage — that would imply it might still be listed.
    expect(String(out.listings_note)).not.toMatch(/could NOT reach/i)
  })
})
