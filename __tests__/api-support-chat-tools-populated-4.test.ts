import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge TOOL-ARM coverage, wave 4 — the arms the first three populated
// waves left dark. `app/api/support-chat/route.ts` is the single largest
// uncovered-branch file in the primary coverage gate (453 uncovered branches
// measured 2026-08-11, ~2× the next file), and the densest remaining cluster
// sits in the special-serial tools and the deal-subscription CRUD.
//
// What is NEW here (deliberately NOT re-covering wave 2's team/badge
// post-filter, or wave 3's escalate_to_human / board readers):
//   - search_serial_deals: the 'perfect' tag, which is a JS filter rather than a
//     SQL column (serial == circulation); the tight-before-coarse SORT; the
//     limit clamp; the HONEST no_results exit; and the listedOnly path with its
//     handler-COMPUTED discount and the embedded-editions array/object shape.
//   - get_special_serial_owners: row mapping + the deliberate custody caveat.
//   - manage_deal_subscriptions: list / pause / resume / delete / create,
//     including the rookie-badge expansion and the not_linked guard.
//
// Assertions target handler-COMPUTED values (discount maths, ordering, derived
// booleans), never a fixture echoed straight back — an echo test passes even if
// the shaping logic is deleted.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  authedEmail: null as string | null,
  userId: null as string | null,
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () =>
        A.authedEmail
          ? { data: { user: { id: A.userId ?? "user-1", email: A.authedEmail } }, error: null }
          : { data: { user: null }, error: null },
    },
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

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  A.sb = spy.fixture
  return spy
}
function post(message: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `pop4-${Math.random()}`, ...extra }),
  })
}
function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const blocks = secondCall?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result in the follow-up model call")
  return JSON.parse(tr.content)
}

beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.authedEmail = null
  A.userId = null
})

/** A row of topshot_underpriced_serials_board. */
function boardRow(over: Record<string, unknown> = {}) {
  return {
    player_name: "Damian Lillard",
    set_name: "Base Set",
    tier: "RARE",
    serial_number: 7,
    circulation_count: 1000,
    ask_usd: 50,
    serial_fmv_usd: 100,
    edition_fmv_usd: 80,
    serial_multiplier: 1.25,
    discount_pct: 50,
    estimate_quality: "coarse",
    confidence: "MEDIUM",
    nft_id: "111",
    edition_key: "1:2",
    external_id: "1:2",
    ...over,
  }
}

describe("search_serial_deals — board path shaping", () => {
  it("derives is_first_mint / is_perfect_mint rather than trusting the row", async () => {
    install({
      topshot_underpriced_serials_board: { data: [
        boardRow({ serial_number: 1, nft_id: "n1" }),
        boardRow({ serial_number: 1000, circulation_count: 1000, nft_id: "n2" }),
        boardRow({ serial_number: 7, nft_id: "n3" }),
      ], error: null },
    })
    script("search_serial_deals", {})
    await POST(post("find serial deals"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.source).toBe("underpriced_serials_board")
    const rows = r.rows as Array<Record<string, unknown>>
    expect(rows.find((x) => x.serial === 1)?.is_first_mint).toBe(true)
    // serial === circulation is a "perfect mint" and must be COMPUTED — the
    // board carries no such column.
    expect(rows.find((x) => x.serial === 1000)?.is_perfect_mint).toBe(true)
    expect(rows.find((x) => x.serial === 7)?.is_first_mint).toBe(false)
    expect(rows.find((x) => x.serial === 7)?.is_perfect_mint).toBe(false)
  })

  it("filters tag='perfect' in JS (serial === circulation), since it is not a SQL column", async () => {
    install({
      topshot_underpriced_serials_board: { data: [
        boardRow({ serial_number: 500, circulation_count: 1000, nft_id: "no" }),
        boardRow({ serial_number: 1000, circulation_count: 1000, nft_id: "yes" }),
      ], error: null },
    })
    script("search_serial_deals", { tag: "perfect" })
    await POST(post("perfect mints"))
    const rows = toolResult().rows as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].serial).toBe(1000)
  })

  it("sorts TIGHT estimates ahead of coarse ones regardless of discount", async () => {
    install({
      topshot_underpriced_serials_board: { data: [
        boardRow({ estimate_quality: "coarse", discount_pct: 90, player_name: "Coarse Deep", nft_id: "c" }),
        boardRow({ estimate_quality: "tight", discount_pct: 20, player_name: "Tight Shallow", nft_id: "t" }),
      ], error: null },
    })
    script("search_serial_deals", {})
    await POST(post("serial deals"))
    const rows = toolResult().rows as Array<Record<string, unknown>>
    // A tight estimate at 20% must outrank a coarse one at 90%: the ordering
    // encodes confidence, not headline discount. Sorting by discount alone
    // would surface the least trustworthy number first.
    expect(rows[0].player).toBe("Tight Shallow")
    expect(rows[0].estimate_quality).toBe("tight")
  })

  it("clamps limit into 1..25", async () => {
    install({ topshot_underpriced_serials_board: { data: Array.from({ length: 40 }, (_, i) => boardRow({ nft_id: `n${i}` })), error: null } })
    script("search_serial_deals", { limit: 999 })
    await POST(post("lots of deals"))
    expect((toolResult().rows as unknown[]).length).toBeLessThanOrEqual(25)
  })

  it("returns an HONEST no_results instead of silently widening to all listings", async () => {
    install({ topshot_underpriced_serials_board: { data: [], error: null } })
    script("search_serial_deals", { player: "Nobody" })
    await POST(post("deals for nobody"))
    const r = toolResult()
    // The distinction that matters: "nothing is listed below serial-FMV" is a
    // real answer about the market. Falling back to every listing would answer
    // a question the user did not ask and imply discounts that do not exist.
    expect(r.status).toBe("no_results")
    expect(r.source).toBe("underpriced_serials_board")
    expect(String(r.message)).toMatch(/listedOnly=true/)
    expect(String(r.message)).toMatch(/not an error/i)
  })

  it("surfaces a board error as status=error", async () => {
    install({ topshot_underpriced_serials_board: { data: null, error: { message: "boom" } } })
    script("search_serial_deals", {})
    await POST(post("serial deals"))
    const r = toolResult()
    expect(r.status).toBe("error")
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(String(r.message)).not.toContain("boom")
  })
})

describe("search_serial_deals — listedOnly path", () => {
  function listing(over: Record<string, unknown> = {}) {
    return {
      serial_number: 1,
      nft_id: "L1",
      ask_usd: 60,
      serial_fmv_usd: 100,
      edition_key: "1:2",
      edition_id: "e1",
      editions: {
        player_name: "Dame",
        set_name: "Base Set",
        tier: "RARE",
        circulation_count: 1000,
        collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
        team_name: "Portland Trail Blazers",
        external_id: "1:2",
      },
      ...over,
    }
  }

  it("computes discount_pct from ask vs serial_fmv", async () => {
    install({ topshot_active_listings: { data: [listing()], error: null } })
    script("search_serial_deals", { listedOnly: true })
    await POST(post("all listed special serials"))
    const rows = toolResult().rows as Array<Record<string, unknown>>
    // (100-60)/100 = 40.0%, rounded to one decimal by the handler.
    expect(rows[0].discount_pct).toBe(40)
    expect(rows[0].player).toBe("Dame")
    expect(rows[0].is_first_mint).toBe(true)
  })

  it("accepts the embedded editions relation as an ARRAY as well as an object", async () => {
    // PostgREST returns an embedded relation as an array or an object depending
    // on the join; the handler normalises both. A shape change must not blank
    // every display field.
    install({ topshot_active_listings: { data: [listing({ editions: [listing().editions] })], error: null } })
    script("search_serial_deals", { listedOnly: true })
    await POST(post("all listed"))
    const rows = toolResult().rows as Array<Record<string, unknown>>
    expect(rows[0].player).toBe("Dame")
    expect(rows[0].set).toBe("Base Set")
  })

  it("leaves discount null when serial_fmv is absent rather than inventing 0%", async () => {
    install({ topshot_active_listings: { data: [listing({ serial_fmv_usd: null })], error: null } })
    script("search_serial_deals", { listedOnly: true })
    await POST(post("all listed"))
    const rows = toolResult().rows as Array<Record<string, unknown>>
    // A missing FMV means "unknown discount". Rendering 0% would assert the ask
    // is exactly fair — a fabricated claim.
    expect(rows[0].discount_pct).toBeNull()
    expect(rows[0].serial_fmv).toBeNull()
  })

  it("surfaces a listings error as status=error", async () => {
    install({ topshot_active_listings: { data: null, error: { message: "listings down" } } })
    script("search_serial_deals", { listedOnly: true })
    await POST(post("all listed"))
    expect(toolResult().status).toBe("error")
  })
})

describe("get_special_serial_owners", () => {
  it("maps rows and keeps the custody caveat attached", async () => {
    install({
      "rpc:get_special_serial_owners_board": {
        data: [
          {
            player_name: "Dame",
            set_name: "Base Set",
            tier: "RARE",
            serial: 1,
            circulation_count: 1000,
            tag: "#1",
            holder_address: "0xbd94cade097e50ac",
            edition_fmv: 250,
            edition_key: "1:2",
          },
        ],
        error: null,
      },
    })
    script("get_special_serial_owners", { tag: "#1" })
    await POST(post("who owns the #1s"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    const rows = r.rows as Array<Record<string, unknown>>
    expect(rows[0].kind).toBe("#1")
    expect(rows[0].edition_fmv).toBe(250)
    expect(String(rows[0].edition_url)).toContain("/nba-top-shot/edition/")
    // The caveat is load-bearing: wmc holder is "latest seen", not live custody.
    // Dropping it would let the model state ownership as present fact.
    expect(String(r.note)).toMatch(/not a present-custody guarantee/i)
  })

  it("returns status=error when the RPC fails", async () => {
    install({ "rpc:get_special_serial_owners_board": { data: null, error: { message: "rpc down" } } })
    script("get_special_serial_owners", { tag: "#1" })
    await POST(post("who owns the #1s"))
    expect(toolResult().status).toBe("error")
  })
})

describe("manage_deal_subscriptions", () => {
  it("refuses without a resolved session, with bot-DM-specific wording", async () => {
    script("manage_deal_subscriptions", { action: "list" })
    await POST(post("list my alerts", { pageContext: "bot_dm" }))
    const r = toolResult()
    // owner_key is the auth uid and is NEVER client-supplied; with no session
    // the only correct answer is "link your account first".
    expect(r.status).toBe("not_linked")
    expect(String(r.message)).toMatch(/\/link/)
  })

  it("lists the caller's subscriptions with the cadence caveat", async () => {
    A.authedEmail = "t@example.com"
    A.userId = "user-1"
    install({
      alert_subscriptions: {
        data: [
          { id: "s1", label: "Dame deals", active: true, channels: ["email"], cadence: "daily", min_discount: 20 },
        ],
        error: null,
      },
    })
    script("manage_deal_subscriptions", { action: "list" })
    await POST(post("list my alerts"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.total).toBe(1)
    expect(String(r.note)).toMatch(/once per day per channel/i)
  })

  // ⚠ A PRICE IS THE USER'S THRESHOLD — do not add an FMV one on top.
  // "alert me any time a Damian Lillard Archive moment lists for $0.60 or less"
  // was SAVED as `max_price 0.60 AND min_discount 25`, a condition the user
  // never named, while the confirmation said "whenever one lists at $0.60 or
  // under". The alert was strictly narrower than the sentence describing it, so
  // its silence was indistinguishable from "nothing has listed" (Trevor,
  // 2026-08-16).
  it("does not add a 25% FMV condition when the user named only a price", async () => {
    A.authedEmail = "t@example.com"
    A.userId = "user-1"
    const spy = install({
      alert_subscriptions: { data: { id: "s9", label: "L", channels: ["telegram"] }, error: null },
      notification_channels: { data: [{ channel: "telegram" }], error: null },
    })
    script("manage_deal_subscriptions", {
      action: "create",
      players: ["Damian Lillard"],
      sets: ["Archive"],
      max_price: 0.6,
    })
    await POST(post("alert me when a Lillard Archive lists at $0.60 or less"))
    const written = spy.writes["alert_subscriptions"]?.[0]?.rows?.[0] as Record<string, unknown>
    expect(written.max_price).toBe(0.6)
    // ⚠ 0, never null: the column is NOT NULL DEFAULT 25, so null throws 23502
    // and no alert is created at all — worse than the bug being fixed.
    expect(written.min_discount).toBe(0)
  })

  it("still applies the 25% default when NO price was given", async () => {
    // The default earns its place on an open-ended request, where a threshold
    // is the only thing between an alert and a firehose.
    A.authedEmail = "t@example.com"
    A.userId = "user-1"
    const spy = install({
      alert_subscriptions: { data: { id: "s10", label: "L", channels: ["telegram"] }, error: null },
      notification_channels: { data: [{ channel: "telegram" }], error: null },
    })
    script("manage_deal_subscriptions", { action: "create", sets: ["Base Set"] })
    await POST(post("alert me on good Base Set deals"))
    const written = spy.writes["alert_subscriptions"]?.[0]?.rows?.[0] as Record<string, unknown>
    expect(written.min_discount).toBe(25)
  })

  it("reports every saved filter back, including the residual FMV condition", async () => {
    A.authedEmail = "t@example.com"
    A.userId = "user-1"
    install({
      alert_subscriptions: { data: { id: "s11", label: "L", channels: ["telegram"] }, error: null },
      notification_channels: { data: [{ channel: "telegram" }], error: null },
    })
    script("manage_deal_subscriptions", { action: "create", players: ["Damian Lillard"], max_price: 0.6 })
    await POST(post("alert me at $0.60"))
    const r = toolResult()
    const filters = (r.applied_filters as string[]).join(" | ")
    expect(filters).toMatch(/at or below \$0\.6/i)
    expect(filters).toMatch(/Damian Lillard/)
    // ⚠ min_discount 0 is NOT "no FMV condition" — the scanner still requires
    // discount_pct >= 0 and fmv_usd > 0, so an over-FMV listing under the price
    // cap will not fire. Disclosed, or it is the same invisible filter smaller.
    expect(filters).toMatch(/at or below FMV/i)
    expect(String(r.applied_filters_note)).toMatch(/State EVERY entry/i)
  })

  it("surfaces a list error rather than an empty subscription set", async () => {
    A.authedEmail = "t@example.com"
    A.userId = "user-1"
    install({ alert_subscriptions: { data: null, error: { message: "table gone" } } })
    script("manage_deal_subscriptions", { action: "list" })
    await POST(post("list my alerts"))
    const r = toolResult()
    // An outage must not read as "you have no alerts" — that would invite the
    // user to recreate subscriptions they already own.
    expect(r.status).toBe("error")
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect(String(r.message)).not.toContain("table gone")
  })
})
