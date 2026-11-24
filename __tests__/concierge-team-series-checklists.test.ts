import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// 2026-11-23: get_team_checklist's series_checklists arm (the team page's Series Checklists panel),
// driven through the real tool-use loop. Claims: a scored wallet gets owned / to-go / missing players
// and a Closest series; an UNWALKED wallet gets none of them (unknown, not zero); a failed series
// read is "unavailable" and never fails the edition checklist; an unlisted player is not priced.

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ messages: Array<{ role: string; content: unknown }> }>,
  sb: null as unknown,
  authedEmail: null as string | null,
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
          ? { data: { user: { id: "user-1", email: A.authedEmail } }, error: null }
          : { data: { user: null }, error: null },
    },
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
process.env.INGEST_SECRET_TOKEN = "ingest"

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
    body: JSON.stringify({ message, sessionId: `tx-${Math.random()}`, ...extra }),
  })
}
function script(toolName: string, input: unknown) {
  A.state.script = [{ tools: [{ name: toolName, input }] }, { text: "done" }]
  A.state.cursor = 0
}
function toolResult(): Record<string, unknown> {
  const secondCall = A.createCalls.at(-1)
  const lastMsg = secondCall?.messages.at(-1)
  const blocks = lastMsg?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result in the follow-up model call")
  return JSON.parse(tr.content)
}
let fetchMock: ReturnType<typeof installFetchMock> | null = null
function stubFetch(stubs: FetchStub[]) { fetchMock = installFetchMock(stubs); return fetchMock }
afterEach(() => { fetchMock?.restore(); fetchMock = null })
beforeEach(() => { install({}); A.createCalls.length = 0; A.authedEmail = null })

const TEAM = { data: { status: "one", primary_name: "Dallas Mavericks", franchise_slug: "dallas-mavericks" }, error: null }
const SERIES = {
  wallet_cached: true,
  series: [
    { series_num: 9, players_total: 6, players_owned: 5, to_go: 1, cost_to_go_usd: 12.5, unlisted: 0, complete: false,
      players: [
        { player_key: "a", player_name: "Cooper Flagg", owned: false, owned_count: 0, cheapest_ask_usd: 12.5, cheapest_route_slug: "1:2", cheapest_name: "x", thumbnail_url: null, edition_count: 1 },
        { player_key: "b", player_name: "Kyrie Irving", owned: true, owned_count: 2, cheapest_ask_usd: 0.2, cheapest_route_slug: "1:3", cheapest_name: "y", thumbnail_url: null, edition_count: 1 },
      ] },
    { series_num: 7, players_total: 20, players_owned: 17, to_go: 3, cost_to_go_usd: 40, unlisted: 1, complete: false, players: [] },
  ],
}
const EDITIONS = (cached: boolean) => ({ has_parallels: false, progress: { wallet_cached: cached, total: 1, owned: 0 }, editions: [{ route_slug: "1:2", player_name: "Cooper Flagg", tier: "COMMON", series_num: 9, owned: false, fmv_usd: 10 }] })
const W = "0x4cb714691dddf5a1"

describe("concierge get_team_checklist — series_checklists", () => {
  it("a scored wallet: owned / to-go / missing players with links, and the closest series", async () => {
    install({ "rpc:resolve_team_name": TEAM })
    const f = stubFetch([jsonRoute("/api/entity/team-series-checklists", SERIES), jsonRoute("/api/entity/team-checklist-full-editions", EDITIONS(true))])
    script("get_team_checklist", { team: "Mavs", collectionId: "nba-top-shot", wallet: W })
    await POST(post("which mavs series am i closest to finishing", { collectionId: "nba-top-shot" }))
    const r = toolResult() as any
    expect(f.calls.some((c) => c.url.includes("/api/entity/team-series-checklists?") && c.url.includes(`wallet=${W}`))).toBe(true)
    expect(r.series_checklists.status).toBe("ok")
    expect(r.series_checklists.closest_series_num).toBe(9)
    const s9 = r.series_checklists.series[0]
    expect(s9).toMatchObject({ series_num: 9, players_total: 6, players_owned: 5, to_go: 1, cost_to_go_usd: 12.5 })
    expect(s9.missing_players.map((p: any) => p.player)).toEqual(["Cooper Flagg"])
    expect(String(s9.missing_players[0].url)).toMatch(/\/nba-top-shot\/edition\/1(:|%3A)2$/)
    expect(r.series_checklists.series[1].unlisted).toBe(1)
    expect(r.series_checklists.how_to_read).toMatch(/never \$0/)
  })

  it("an unwalked wallet: no owned, to-go, cost, missing players or closest — unknown, not zero", async () => {
    install({ "rpc:resolve_team_name": TEAM })
    stubFetch([jsonRoute("/api/entity/team-series-checklists", { ...SERIES, wallet_cached: false }), jsonRoute("/api/entity/team-checklist-full-editions", EDITIONS(false))])
    script("get_team_checklist", { team: "Mavs", collectionId: "nba-top-shot", wallet: W })
    await POST(post("mavs checklist", { collectionId: "nba-top-shot" }))
    const r = toolResult() as any
    expect(r.series_checklists.closest_series_num).toBeNull()
    const s9 = r.series_checklists.series[0]
    expect(s9.players_total).toBe(6)
    expect(s9).not.toHaveProperty("players_owned")
    expect(s9).not.toHaveProperty("to_go")
    expect(s9.cost_to_go_usd).toBeNull()
    expect(s9.missing_players).toBeUndefined()
  })

  it("a failed series read is 'unavailable' and the edition checklist still answers", async () => {
    install({ "rpc:resolve_team_name": TEAM })
    stubFetch([jsonRoute("/api/entity/team-series-checklists", { error: "boom" }, { status: 500, ok: false }), jsonRoute("/api/entity/team-checklist-full-editions", EDITIONS(true))])
    script("get_team_checklist", { team: "Mavs", collectionId: "nba-top-shot" })
    await POST(post("mavs checklist", { collectionId: "nba-top-shot" }))
    const r = toolResult() as any
    expect(r.status).toBe("ok")
    expect(r.total_editions).toBe(1)
    expect(r.series_checklists.status).toBe("unavailable")
    expect(r.series_checklists).not.toHaveProperty("series")
  })
})
