import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture, installFetchMock, jsonRoute } from "./helpers/route-harness"

// Deep test for GET /api/support-chat/context — drives the session-continuity,
// signed-in beta-tester cross-session welcome, and gated market-status shaping
// the shallow test (anonymous default payload) leaves cold. Identity is derived
// server-side from the auth seam (never the querystring), so both the auth mock
// and the module Supabase client are stubbed table-keyed.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  authUser: null as null | { email: string },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/auth/supabase-server", () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.authUser }, error: null }) },
  }),
}))

import { GET } from "@/app/api/support-chat/context/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  state.sb = null
  state.authUser = null
})

describe("GET /api/support-chat/context — session continuity", () => {
  it("marks a returning session and personalizes the welcome with the last player searched", async () => {
    install({
      chat_sessions: {
        data: {
          last_topics: ["deals", "fmv"],
          last_player_searched: "Damian Lillard",
          conversation_count: 3,
          last_seen_at: "2026-07-16T00:00:00Z",
        },
        error: null,
      },
    })

    const body = await (await GET(req("https://t/api/support-chat/context?sessionId=s1"))).json()
    expect(body.returningUser).toBe(true)
    expect(body.lastTopics).toEqual(["deals", "fmv"])
    expect(body.lastPlayerSearched).toBe("Damian Lillard")
    expect(body.conversationCount).toBe(3)
    expect(body.pageWelcome).toContain("Damian Lillard")
  })
})

describe("GET /api/support-chat/context — signed-in beta tester", () => {
  it("uses the cross-session conversation count + last open feedback for a shipped-feedback welcome", async () => {
    state.authUser = { email: "me@x.com" }
    install({
      allow_list: { data: { username: "collector", wallet_addr: "0xabc" }, error: null },
      support_conversations: { count: 3, error: null },
      beta_feedback_inbox: {
        data: {
          id: 7,
          feedback_type: "bug",
          feedback_summary: "dark mode toggle",
          feedback_status: "shipped",
          created_at: "2026-07-15T00:00:00Z",
        },
        error: null,
      },
    })

    const body = await (await GET(req("https://t/api/support-chat/context"))).json()
    expect(body.returningBetaTester).toBe(true)
    expect(body.conversationCount).toBe(3)
    expect(body.lastOpenFeedback.id).toBe(7)
    expect(body.pageWelcome).toContain("shipped")
    expect(body.pageWelcome).toContain("dark mode toggle")
    expect(body.pageSuggestions).toContain("Find me a deal")
  })
})

describe("GET /api/support-chat/context — market status (opt-in)", () => {
  it("shapes the daily deal from sniper-feed and computes the market pulse line", async () => {
    install({
      "rpc:get_market_pulse": {
        data: [{ deals_below_20: 5, deals_below_30: 2, total_tracked: 100 }],
        error: null,
      },
      "rpc:get_fmv_movers": { data: [], error: null },
    })

    const h = installFetchMock([
      jsonRoute("sniper-feed", {
        deals: [
          {
            playerName: "Dame",
            askPrice: 10,
            discount: 23.6,
            tier: "COMMON",
            setName: "Base Set",
            seriesName: "S1",
            adjustedFmv: 13,
            source: "topshot",
            buyUrl: "http://buy",
          },
        ],
      }),
    ])

    try {
      const body = await (
        await GET(req("https://t/api/support-chat/context?includeMarketStatus=true"))
      ).json()
      expect(body.dailyDeal).toMatchObject({
        player_name: "Dame",
        low_ask: 10,
        discount_pct: 24, // rounded from 23.6
        tier: "Common", // tierLabel(COMMON)
        source: "topshot",
      })
      expect(body.marketPulse).toContain("2 moment")
      expect(body.marketPulse).toContain("30%+ below FMV")
    } finally {
      h.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// The market-context FALLBACK LADDERS. The existing case drives the happy
// sniper-feed + get_market_pulse path; every fallback beneath it stayed cold:
//   dailyDeal:   sniper-feed fails/empty -> cached_listings discount row
//   marketPulse: get_market_pulse tiers -> fmv_movers append -> count fallback
// Plus the returning-tester pageWelcome variants keyed on feedback status.
// ---------------------------------------------------------------------------

const MKT = "https://t/api/support-chat/context?includeMarketStatus=true"

describe("GET /api/support-chat/context — dailyDeal fallback", () => {
  it("falls back to a cached_listings discount row when sniper-feed yields nothing", async () => {
    install({
      cached_listings: {
        data: [{
          player_name: "Ja Morant", set_name: "Base Set", series_name: "S4",
          tier: "RARE", ask_price: "42.5", fmv: "80", discount: "46.8",
          badge_slugs: ["rookie-mint"], buy_url: "http://buy/x",
        }],
        error: null,
      },
      "rpc:get_market_pulse": { data: [], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = installFetchMock([jsonRoute("sniper-feed", { deals: [] })])
    try {
      const body = await (await GET(req(MKT))).json()
      expect(body.dailyDeal).toMatchObject({
        player_name: "Ja Morant",
        tier: "Rare",
        low_ask: 42.5,
        fmv: 80,
        discount_pct: 47, // rounded
        badges: ["rookie-mint"],
        buy_url: "http://buy/x",
      })
    } finally { h.restore() }
  })

  it("leaves dailyDeal null when both the feed and the fallback are empty", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = installFetchMock([jsonRoute("sniper-feed", { deals: [] })])
    try {
      const body = await (await GET(req(MKT))).json()
      expect(body.dailyDeal).toBeNull()
    } finally { h.restore() }
  })

  it("survives a sniper-feed transport failure and still answers 200", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = installFetchMock([
      { match: () => true, respond: () => { throw new Error("feed down") } } as never,
    ])
    try {
      const res = await GET(req(MKT))
      expect(res.status).toBe(200)
      expect((await res.json()).dailyDeal).toBeNull()
    } finally { h.restore() }
  })
})

describe("GET /api/support-chat/context — marketPulse ladder", () => {
  const feedEmpty = () => installFetchMock([jsonRoute("sniper-feed", { deals: [] })])

  it("prefers the 30%+ tier over the 20%+ tier", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [{ deals_below_20: 9, deals_below_30: 1, total_tracked: 50 }], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = feedEmpty()
    try {
      const body = await (await GET(req(MKT))).json()
      expect(body.marketPulse).toContain("1 moment listed 30%+")
      expect(body.marketPulse).not.toContain("20%+")
    } finally { h.restore() }
  })

  it("uses the 20%+ tier when nothing is 30%+ below", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [{ deals_below_20: 4, deals_below_30: 0, total_tracked: 50 }], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = feedEmpty()
    try {
      expect((await (await GET(req(MKT))).json()).marketPulse).toContain("4 moments listed 20%+")
    } finally { h.restore() }
  })

  it("falls back to the tracked-count line when no discount tier fires", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [{ deals_below_20: 0, deals_below_30: 0, total_tracked: 777 }], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = feedEmpty()
    try {
      expect((await (await GET(req(MKT))).json()).marketPulse).toContain("777 moments tracked")
    } finally { h.restore() }
  })

  it("appends hot movers (>20% up) to the pulse line", async () => {
    install({
      cached_listings: { data: [], error: null },
      "rpc:get_market_pulse": { data: [{ deals_below_20: 0, deals_below_30: 3, total_tracked: 10 }], error: null },
      "rpc:get_fmv_movers": {
        data: [{ player_name: "Wemby", pct_change: 41.2 }, { player_name: "Cold Guy", pct_change: 5 }],
        error: null,
      },
    })
    const h = feedEmpty()
    try {
      const pulse = (await (await GET(req(MKT))).json()).marketPulse as string
      expect(pulse).toContain("30%+ below FMV")
      expect(pulse).toContain("Wemby up 41%")
      expect(pulse).not.toContain("Cold Guy") // not a hot mover
    } finally { h.restore() }
  })

  it("uses the count-only fallback when the pulse RPC gives nothing", async () => {
    install({
      cached_listings: { data: [], error: null, count: 12 },
      "rpc:get_market_pulse": { data: [], error: null },
      "rpc:get_fmv_movers": { data: [], error: null },
    })
    const h = feedEmpty()
    try {
      const body = await (await GET(req(MKT))).json()
      expect(body.marketPulse === null || String(body.marketPulse).includes("30%+")).toBe(true)
    } finally { h.restore() }
  })
})
