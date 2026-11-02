import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute, type FetchStub } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge coverage for the 2026-07-20 read-only market/ecosystem tools
// (get_top_sales / get_market_movers / get_rookies / get_premiums /
// get_ecosystem_stat / get_insight_board) and their shared fetchPublicInsight
// helper — the enum→path maps, param plumbing, and the helper's rows/meta/
// non-row/non-200/json-error branches, all previously dark. Same harness as
// api-support-chat-tools.test.ts.

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

const { POST } = await import("@/app/api/support-chat/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  A.sb = makeInstrumentedSupabaseFixture(fixtures).fixture
}
function post(message: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message, sessionId: `eco-${Math.random()}`, ...extra }),
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

let fetchMock: ReturnType<typeof installFetchMock> | null = null
function stubFetch(stubs: FetchStub[]) {
  fetchMock = installFetchMock(stubs)
  return fetchMock
}
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.authedEmail = null
})

async function drive(tool: string, input: unknown, stubs: FetchStub[] = []) {
  if (stubs.length) stubFetch(stubs)
  script(tool, input)
  await POST(post("ecosystem query"))
  return toolResult()
}

describe("concierge — get_top_sales", () => {
  it("maps the app collection slug + window + clamps limit into the top-sales board query", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }, { id: 2 }], meta: { window: "30d" } })])
    script("get_top_sales", { collectionId: "nba-top-shot", window: "30d", limit: 2 })
    await POST(post("top sales"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", count: 2 })
    expect(r.meta).toMatchObject({ window: "30d" })
    const url = f.calls.find((c) => c.url.includes("/top-sales"))!.url
    expect(url).toContain("collection=nba_top_shot")
    expect(url).toContain("window=30d")
    expect(url).toContain("limit=2")
  })

  it("defaults to a 7d window and omits collection when none is in context", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [] })])
    script("get_top_sales", {})
    await POST(post("top sales"))
    const url = f.calls.find((c) => c.url.includes("/top-sales"))!.url
    expect(url).toContain("window=7d")
    expect(url).not.toContain("collection=")
  })
})

describe("concierge — get_top_sales on an EMPTY collection window (2026-10-18)", () => {
  // Cowork QA 10-18: an empty Golazos window was answered "either a quiet week or the
  // indexer missed a sale" — a guess, when RPC knows the newest indexed sale exactly.
  const golazosPulse = { slug: "laliga_golazos", sales_24h: 0, sales_7d: 0, sales_30d: 3, last_sale_at: "2026-10-01T18:00:00+00:00" }
  it("attaches the collection's newest indexed sale from market-pulse and forbids guessing why", async () => {
    const f = stubFetch([
      jsonRoute("/api/public/insights/top-sales", { rows: [] }),
      jsonRoute("/api/public/insights/market-pulse", { rows: [{ slug: "nba_top_shot", last_sale_at: "2026-10-19T00:00:00+00:00" }, golazosPulse] }),
    ])
    script("get_top_sales", { collectionId: "laliga-golazos" })
    await POST(post("last golazos sale"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", count: 0, last_indexed_sale_at: "2026-10-01T18:00:00+00:00" })
    expect(String(r.note)).toMatch(/INDEXED/)
    expect(String(r.note)).toMatch(/Never guess why/)
    expect(f.calls.some((c) => c.url.includes("/market-pulse"))).toBe(true)
  })
  // 2026-10-25 replay: the board's $100 bar emptied a Golazos week that held 126
  // indexed sales, and the note said "No sales are INDEXED" — the model repeated it
  // and offered to log the board as a bug. The window's own count must decide.
  it("sales indexed UNDER the $100 bar: says they exist, gives the count and top sale, never 'none indexed'", async () => {
    stubFetch([
      jsonRoute("/api/public/insights/top-sales", { rows: [] }),
      jsonRoute("/api/public/insights/market-pulse", {
        rows: [{ slug: "laliga_golazos", sales_7d: 126, top_sale_7d: 20, sales_30d: 127, top_sale_30d: 20, last_sale_at: "2026-10-25T01:43:51+00:00" }],
      }),
    ])
    script("get_top_sales", { collectionId: "laliga-golazos" })
    await POST(post("what did the most recent golazos sale go for"))
    const r = toolResult()
    expect(r).toMatchObject({ status: "ok", count: 0, board_min_price_usd: 100, indexed_sales_in_window: 126, top_sale_in_window_usd: 20, last_indexed_sale_at: "2026-10-25T01:43:51+00:00" })
    const note = String(r.note)
    expect(note).not.toMatch(/No sales are INDEXED/)
    expect(note).toMatch(/\$100 or more/)
    expect(note).toMatch(/NOT a bug/)
    expect(note).toMatch(/126 sales/)
  })
  it("reads the 30d counts when the window is 30d", async () => {
    stubFetch([
      jsonRoute("/api/public/insights/top-sales", { rows: [] }),
      jsonRoute("/api/public/insights/market-pulse", { rows: [{ slug: "laliga_golazos", sales_7d: 0, sales_30d: 9, top_sale_30d: 40, last_sale_at: "2026-10-10T00:00:00+00:00" }] }),
    ])
    script("get_top_sales", { collectionId: "laliga-golazos", window: "30d" })
    await POST(post("golazos sales this month"))
    expect(toolResult()).toMatchObject({ indexed_sales_in_window: 9, top_sale_in_window_usd: 40 })
  })
  it("a FAILED market-pulse read attaches no date and says it could not be read", async () => {
    stubFetch([
      jsonRoute("/api/public/insights/top-sales", { rows: [] }),
      jsonRoute("/api/public/insights/market-pulse", {}, { status: 503, ok: false }),
    ])
    script("get_top_sales", { collectionId: "laliga-golazos" })
    await POST(post("last golazos sale"))
    const r = toolResult()
    expect(r.last_indexed_sale_at).toBeUndefined()
    expect(String(r.note)).toMatch(/could not be read/)
  })
  it("does NOT touch a window that has rows, and never reads market-pulse for it", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    script("get_top_sales", { collectionId: "laliga-golazos" })
    await POST(post("top golazos sales"))
    const r = toolResult()
    expect(r.note).toBeUndefined()
    expect(r.last_indexed_sale_at).toBeUndefined()
    expect(f.calls.some((c) => c.url.includes("/market-pulse"))).toBe(false)
  })
  it("the cross-collection board (no collection) is left as it was", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [] })])
    script("get_top_sales", {})
    await POST(post("top sales"))
    expect(toolResult().note).toBeUndefined()
    expect(f.calls.some((c) => c.url.includes("/market-pulse"))).toBe(false)
  })
})

describe("concierge — the model is told the time, below the cache breakpoint (2026-10-18)", () => {
  it("the per-request system block carries the current time and the no-UTC rule; the cached block does not", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    script("get_top_sales", {})
    await POST(post("top sales"))
    const sys = (A.createCalls[0] as unknown as { system: Array<{ text: string; cache_control?: unknown }> }).system
    const cached = sys.find((b) => b.cache_control)!.text
    const dynamic = sys.find((b) => !b.cache_control)!.text
    expect(dynamic).toMatch(/## Time\nThe current time is \d{4}-\d{2}-\d{2}T/)
    expect(dynamic).toMatch(/never quote a clock time in UTC/)
    expect(cached).not.toMatch(/The current time is/)
  })
  // 2026-10-25 replay: edition-page answers called Lillard's Archive Set (on-chain
  // 3, Summer 2021) "Series 3". The decode is generated from SERIES_DISPLAY.
  it("the prompt decodes Top Shot on-chain series numbers from the canonical map", async () => {
    const { SERIES_DISPLAY } = await import("@/lib/series-label")
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    script("get_top_sales", {})
    await POST(post("top sales"))
    const sys = (A.createCalls[0] as unknown as { system: Array<{ text: string }> }).system.map((b) => b.text).join("\n")
    for (const [n, label] of Object.entries(SERIES_DISPLAY)) expect(sys).toContain(`${n} = ${label}`)
    expect(sys).toContain("3 = Summer 2021")
    expect(sys).toMatch(/never "Series N" from the raw number/)
  })
})

describe("concierge — market-pulse / rookies", () => {
  it("get_market_movers reads the market-pulse board", async () => {
    const r = await drive("get_market_movers", { limit: 5 }, [jsonRoute("/api/public/insights/market-pulse", { rows: [{ m: 1 }] })])
    expect(r).toMatchObject({ status: "ok", count: 1 })
    // No empty window → no annotation, no note.
    expect(r.note).toBeUndefined()
    expect((r.rows as Array<Record<string, unknown>>)[0].no_sales_indexed).toBeUndefined()
  })
  // 2026-10-14: a zero-sales window is "none INDEXED", not "nobody traded".
  it("get_market_movers marks windows with no indexed sales and says how to phrase them", async () => {
    const candy = { slug: "candy_mlb", sales_24h: 0, volume_24h: 0, sales_7d: 464, volume_7d: 781.83, sales_30d: 1333, last_sale_at: "2026-10-12T03:21:04+00:00" }
    const busy = { slug: "nba_top_shot", sales_24h: 2095, sales_7d: 17074, sales_30d: 75873, last_sale_at: "2026-10-15T02:20:48+00:00" }
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { rows: [busy, candy] })])
    expect(r.status).toBe("ok")
    expect((r.rows as Array<Record<string, unknown>>)[1].no_sales_indexed).toEqual(["24h"])
    expect((r.rows as Array<Record<string, unknown>>)[1].last_sale_at).toBe("2026-10-12T03:21:04+00:00")
    expect((r.rows as Array<Record<string, unknown>>)[0].no_sales_indexed).toBeUndefined()
    expect(String(r.note)).toMatch(/NO SALES INDEXED/)
    expect(String(r.note)).toMatch(/never 'nobody traded'/)
  })
  it("get_market_movers passes a failed board through untouched", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { error: "Board unavailable" })])
    expect(r).toMatchObject({ status: "error" })
    expect(r.note).toBeUndefined()
  })
  it("get_rookies forwards the sort param", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/rookies", { rows: [] })])
    script("get_rookies", { sort: "mint_desc", limit: 3 })
    await POST(post("rookies"))
    expect(f.calls.find((c) => c.url.includes("/rookies"))!.url).toContain("sort=mint_desc")
  })
  it("get_rookies forwards class=2026 (this season's rookies) beside sort", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/rookies", { rows: [] })])
    script("get_rookies", { class: "2026", sort: "gmv" })
    await POST(post("this year's rookies"))
    const url = f.calls.find((c) => c.url.includes("/rookies"))!.url
    expect(url).toContain("class=2026")
    expect(url).toContain("sort=gmv")
  })
  // 2026-10-26 (All Day ↔ Top Shot parity pass 5): an All Day rookie question reads the 2025 NFL class —
  // never an NBA class, even when the model passes one.
  it("get_rookies on NFL All Day reads class=nfl-2025, whatever class was passed", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/rookies", { rows: [{ player_name: "Ashton Jeanty" }] })])
    script("get_rookies", { collectionId: "nfl-all-day", class: "2026", sort: "gmv" })
    await POST(post("nfl rookies"))
    const url = f.calls.find((c) => c.url.includes("/rookies"))!.url
    expect(url).toContain("class=nfl-2025")
    expect(url).not.toContain("class=2026")
    expect(url).toContain("sort=gmv")
  })
})

describe("concierge — get_premiums enum dispatch", () => {
  it.each([
    ["serial", "serial-premiums"],
    ["parallel", "parallel-premiums"],
  ])("routes kind=%s to the %s board", async (kind, path) => {
    const f = stubFetch([jsonRoute(`/api/public/insights/${path}`, { rows: [{ x: 1 }] })])
    script("get_premiums", { kind, limit: 10 })
    await POST(post("premiums"))
    expect(f.calls.some((c) => c.url.includes(`/${path}`))).toBe(true)
    expect(toolResult()).toMatchObject({ status: "ok" })
  })
  it("rejects an unknown kind without fetching", async () => {
    const r = await drive("get_premiums", { kind: "bogus" })
    expect(r).toMatchObject({ status: "error" })
    expect(String(r.message)).toContain("parallel")
  })
})

describe("concierge — get_ecosystem_stat + get_insight_board enum maps", () => {
  it("maps a valid ecosystem metric to its board path", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/new-collectors", { rows: [{ w: "0x1" }] })])
    script("get_ecosystem_stat", { metric: "new_collectors" })
    await POST(post("who's new"))
    expect(f.calls.some((c) => c.url.includes("/new-collectors"))).toBe(true)
    expect(toolResult()).toMatchObject({ status: "ok", count: 1 })
  })
  // 2026-10-26: first_mint / offer_spread are per-collection boards — All Day reads its own leg, any other named
  // collection is refused rather than answered with Top Shot's rows.
  it.each([["first_mint", "first-mint"], ["offer_spread", "offer-spread"]])("%s on NFL All Day reads ?collection=nfl-all-day", async (metric, path) => {
    const f = stubFetch([jsonRoute(`/api/public/insights/${path}`, { rows: [{ x: 1 }] })])
    script("get_ecosystem_stat", { metric, collectionId: "nfl-all-day" })
    await POST(post("all day board"))
    const url = f.calls.find((c) => c.url.includes(`/${path}`))!.url
    expect(url).toContain("collection=nfl-all-day")
  })
  it.each(["first_mint", "offer_spread"])("%s on another collection is refused, never Top Shot's rows", async (metric) => {
    const r = await drive("get_ecosystem_stat", { metric, collectionId: "laliga-golazos" })
    expect(r).toMatchObject({ status: "unsupported_collection" })
  })
  it("a metric named like an Object.prototype key is an error, not a crash", async () => {
    expect(await drive("get_ecosystem_stat", { metric: "constructor" })).toMatchObject({ status: "error" })
  })
  it("rejects an unknown ecosystem metric", async () => {
    expect(await drive("get_ecosystem_stat", { metric: "nope" })).toMatchObject({ status: "error" })
  })
  // 2026-10-27: the squeeze board on an All Day question reads All Day's leg, never Top Shot's.
  it("board=squeeze on NFL All Day reads ?collection=nfl-all-day", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "squeeze", collectionId: "nfl-all-day" })
    await POST(post("most squeezed all day"))
    expect(f.calls.find((c) => c.url.includes("/squeeze"))!.url).toContain("collection=nfl-all-day")
  })
  it("board=set_squeeze on NFL All Day reads ?collection=nfl-all-day", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/set-squeeze", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "set_squeeze", collectionId: "nfl-all-day" })
    await POST(post("most squeezed all day sets"))
    expect(f.calls.find((c) => c.url.includes("/set-squeeze"))!.url).toContain("collection=nfl-all-day")
  })
  // 2026-10-31: webz_80 (10-27) asked for one player's most-squeezed editions above 10 circulation, then by top-5
  // hold %; the tool could not pass the board's own filters, so the concierge said it could not filter by player.
  it("board=squeeze forwards player, mint floor/cap, league and sort to the board route", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "squeeze", player: "Ausar Thompson", minCirculation: 11, maxCirculation: 500, minSqueeze: 0, league: "nba", sort: "concentration" })
    await POST(post("ausar thompson squeeze"))
    const u = new URL(f.calls.find((c) => c.url.includes("/squeeze"))!.url, "https://x")
    expect(u.searchParams.get("player")).toBe("Ausar Thompson")
    expect(u.searchParams.get("min_circulation")).toBe("11")
    expect(u.searchParams.get("max_circulation")).toBe("500")
    expect(u.searchParams.get("min_squeeze")).toBe("0")
    expect(u.searchParams.get("league")).toBe("NBA")
    expect(u.searchParams.get("sort")).toBe("concentration")
  })
  it("board=squeeze filters stay off other boards and ride beside the All Day leg", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] }), jsonRoute("/api/public/insights/trophies", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "squeeze", collectionId: "nfl-all-day", player: "Josh Allen" })
    await POST(post("josh allen squeeze all day"))
    const u = new URL(f.calls.find((c) => c.url.includes("/squeeze"))!.url, "https://x")
    expect(u.searchParams.get("collection")).toBe("nfl-all-day")
    expect(u.searchParams.get("player")).toBe("Josh Allen")
  })
  // 10-27 review: the tool's schema had no collectionId, so on an /insights page (no page collection) an
  // All Day question could not reach All Day's leg; and a collection with no squeeze board got Top Shot's.
  it("get_insight_board's schema offers collectionId (the only way an /insights page reaches All Day's leg)", async () => {
    // TOOLS is not exported (a route file exports handlers only): read the tool's own schema block.
    const src = readFileSync(join(process.cwd(), "app/api/support-chat/route.ts"), "utf8")
    const start = src.indexOf('name: "get_insight_board"')
    const block = src.slice(start, src.indexOf("required: [\"board\"]", start))
    expect(start).toBeGreaterThan(0)
    expect(block).toMatch(/properties: \{[\s\S]*\bcollectionId: \{ type: "string"/)
  })
  it("board=squeeze for a collection with no squeeze board is refused, never Top Shot's rows", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] })])
    for (const collectionId of ["laliga-golazos", "candy_mlb"]) {
      expect(await drive("get_insight_board", { board: "squeeze", collectionId })).toMatchObject({ status: "unsupported_collection" })
    }
    expect(f.calls.some((c) => c.url.includes("/squeeze"))).toBe(false)
  })
  // 2026-10-28: the RPC Index (board=market) has an NFL All Day leg; another collection is refused.
  it("board=market on NFL All Day reads ?collection=nfl-all-day", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/market", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "market", collectionId: "nfl-all-day" })
    await POST(post("how is the all day market doing"))
    expect(f.calls.find((c) => c.url.includes("/insights/market"))!.url).toContain("collection=nfl-all-day")
  })
  it("board=market on a collection with no index is refused, never Top Shot's market", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/market", { rows: [{ x: 1 }] })])
    expect(await drive("get_insight_board", { board: "market", collectionId: "laliga-golazos" })).toMatchObject({ status: "unsupported_collection" })
    expect(f.calls.some((c) => c.url.includes("/insights/market"))).toBe(false)
  })
  it("board=market with no collection stays Top Shot's", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/market", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "market" })
    await POST(post("how is the market doing"))
    expect(f.calls.find((c) => c.url.includes("/insights/market"))!.url).not.toContain("collection=")
  })
  // 2026-10-28: Top Shot-only boards are refused on another named collection; trophies filter to it.
  it.each([
    ["set_completers", "/set-completers", ""],
    ["rookie_board", "/rookie-board", ""],
    ["pack_drops", "/pack-drops", ""],
    ["pack_reality", "/pack-reality", "allday_pack_reality"],
    ["topshot_pack_market", "/topshot-pack-market", "allday_pack_market"],
  ])("board=%s on NFL All Day is refused, never Top Shot's rows", async (board, path, alt) => {
    const f = stubFetch([jsonRoute(`/api/public/insights${path}`, { rows: [{ x: 1 }] })])
    const r = await drive("get_insight_board", { board, collectionId: "nfl-all-day" })
    expect(r).toMatchObject({ status: "unsupported_collection" })
    if (alt) expect(String((r as { message?: string }).message)).toContain(alt)
    expect(f.calls.some((c) => c.url.includes(`/api/public/insights${path}`))).toBe(false)
  })
  it("board=set_completers on Top Shot (or no collection) still reads the board", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/set-completers", { rows: [{ x: 1 }] })])
    for (const collectionId of ["nba-top-shot", undefined]) {
      script("get_insight_board", collectionId ? { board: "set_completers", collectionId } : { board: "set_completers" })
      await POST(post("set completers"))
    }
    expect(f.calls.filter((c) => c.url.includes("/set-completers"))).toHaveLength(2)
  })
  it("board=trophies on NFL All Day reads only All Day's trophies; with no collection, every collection's", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/trophies", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "trophies", collectionId: "nfl-all-day" })
    await POST(post("all day trophies"))
    expect(f.calls.find((c) => c.url.includes("/trophies"))!.url).toContain("collection=nfl_all_day")
    script("get_insight_board", { board: "trophies" })
    await POST(post("trophies"))
    expect(f.calls.filter((c) => c.url.includes("/trophies"))[1].url).not.toContain("collection=")
  })
  it("board=trophies on Candy MLB reads Candy's trophies (the room covers every published collection)", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/trophies", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "trophies", collectionId: "candy-mlb" })
    await POST(post("candy trophies"))
    expect(f.calls.find((c) => c.url.includes("/trophies"))!.url).toContain("collection=candy_mlb")
  })
  it("board=squeeze with collectionId nba-top-shot reads Top Shot's board", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "squeeze", collectionId: "nba-top-shot" })
    await POST(post("most squeezed top shot"))
    expect(f.calls.find((c) => c.url.includes("/squeeze"))!.url).not.toContain("collection=")
  })
  it("board=squeeze with no collection stays Top Shot's", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/squeeze", { rows: [{ x: 1 }] })])
    script("get_insight_board", { board: "squeeze" })
    await POST(post("most squeezed"))
    expect(f.calls.find((c) => c.url.includes("/squeeze"))!.url).not.toContain("collection=")
  })
  it("maps a valid insight board enum to its path", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/set-completers", { rows: [{ s: 1 }] })])
    script("get_insight_board", { board: "set_completers" })
    await POST(post("set completers"))
    expect(f.calls.some((c) => c.url.includes("/set-completers"))).toBe(true)
  })
  it("rejects an unknown insight board and lists the valid ones", async () => {
    const r = await drive("get_insight_board", { board: "nonsense" })
    expect(r).toMatchObject({ status: "error" })
    expect(String(r.message)).toContain("squeeze")
  })
})

// 2026-10-31: Top Shot This trade-in math. The finder reads the public board (cost-first, player
// scoped); a wallet reads the one-scan wallet arm and relays players + next_pack with the
// whole-wallet counts; a wallet RPC never walked is not_indexed (never "holds nothing"); a
// username resolves through the same ladder as check_wallet_squeeze; any other named
// collection is refused, never answered with Top Shot's rows.
describe("concierge — get_trade_in (2026-10-31)", () => {
  it("with no wallet reads the finder cheapest-first, scoped to the player", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/trade-in", { rows: [{ player_name: "Nikola Jokić", asp: 5.26, low_ask: 0.35, cost_per_pack: 0.7 }], meta: { asp_per_pack_usd: 10 } })])
    const r = await drive("get_trade_in", { player: "jokic", limit: 5 })
    const url = f.calls.find((c) => c.url.includes("/insights/trade-in"))!.url
    expect(url).toContain("sort=cost")
    expect(url).toContain("player=jokic")
    expect(url).toContain("limit=5")
    expect(r).toMatchObject({ status: "ok", count: 1 })
  })
  it("with a 0x wallet relays players, next_pack and the whole-wallet counts", async () => {
    const fill = { player_name: "LeBron James", packs: 811, to_next_pack: 3.41, external_id: "26:401", set_name: "Base Set", asp: 5.25, low_ask: 2.82, moments_needed: 1, cost: 2.82 }
    stubFetch([jsonRoute("/api/public/insights/trade-in", {
      meta: { wallet: "0xbd94cade097e50ac", total_players: 1323, players_with_fill: 1322, packs_total: 6723 },
      players: [{ player_name: "LeBron James", moments: 92, moments_with_asp: 92, asp_total: 8116.59, packs: 811, to_next_pack: 3.41, fill }, { player_name: "Damian Lillard", moments: 382, moments_with_asp: 382, asp_total: 4171.29, packs: 417, to_next_pack: 8.71, fill: null }],
      next_pack: [fill],
    })])
    const r = await drive("get_trade_in", { wallet: "0xBD94CADE097E50AC", limit: 1 })
    // packs_total is the WHOLE wallet's (every player); the listed slice's own sum is named for what it is
    expect(r).toMatchObject({ status: "ok", wallet: "0xBD94CADE097E50AC", total_players: 1323, players_with_fill: 1322, packs_total: 6723, packs_in_listed_players: 811, players_listed: 1 })
    expect(r.players).toHaveLength(1)
    expect(r.next_pack).toHaveLength(1)
    expect(String(r.rule)).toContain("not RPC FMV")
    expect(JSON.stringify(r)).not.toMatch(/"fmv|confidence/i)
  })
  it("a wallet RPC never walked is not_indexed, never 'holds nothing'", async () => {
    stubFetch([jsonRoute("/api/public/insights/trade-in", { meta: { wallet: "0x00000000000000aa", total_players: 0 }, players: [], next_pack: [] })])
    const r = await drive("get_trade_in", { wallet: "0x00000000000000aa" })
    expect(r).toMatchObject({ status: "not_indexed" })
    expect(String(r.message)).toContain("NOT that the wallet holds nothing")
  })
  it("a username resolves through the Top Shot username ladder before the read", async () => {
    install({ "rpc:resolve_topshot_username": { data: { found: true, wallet_address: "bd94cade097e50ac" }, error: null } })
    const f = stubFetch([jsonRoute("/api/public/insights/trade-in", { meta: { total_players: 1 }, players: [{ player_name: "X", moments: 1, packs: 0 }], next_pack: [] })])
    const r = await drive("get_trade_in", { wallet: "ripcity" })
    expect(f.calls.find((c) => c.url.includes("/insights/trade-in"))!.url).toContain("wallet=0xbd94cade097e50ac")
    expect(r).toMatchObject({ status: "ok", wallet: "0xbd94cade097e50ac", username_input: "ripcity" })
  })
  it("on another collection is refused, never Top Shot's rows", async () => {
    // Stubbed (2026-10-31): unstubbed, this read went to the LIVE site — red in a sandbox with no
    // egress, and a CI pass that depended on production answering.
    stubFetch([jsonRoute("/api/public/insights/trade-in", { meta: { total_players: 1 }, players: [{ player_name: "X", moments: 1, packs: 0 }], next_pack: [] })])
    const r = await drive("get_trade_in", { player: "x" })
    expect(r).toMatchObject({ status: "ok" }) // no collection: Top Shot's
    script("get_trade_in", { player: "x" })
    await POST(post("trade in", { collectionId: "nfl-all-day" }))
    expect(toolResult()).toMatchObject({ status: "unsupported_collection" })
  })
  it("a failed read is an error, never an empty finder or wallet", async () => {
    stubFetch([jsonRoute("/api/public/insights/trade-in", { error: "unavailable" }, { status: 503, ok: false })])
    const r = await drive("get_trade_in", { wallet: "0x00000000000000aa" })
    expect(r).toMatchObject({ status: "error" })
    expect(r.players).toBeUndefined()
  })
})

// 2026-11-02: Top Shot "Chase left". Relays /api/packs/chase with densities rounded and a
// rule that forbids quoting them as a %; another collection is refused (never Top Shot's
// packs); a failed read is an error, never "no chase left"; an ok-empty read says so.
describe("concierge — get_pack_chase (2026-11-02)", () => {
  const row = { distId: "5727", title: "Rookie Revelation: Chance Hit", tier: "legendary", remaining: 1, original: 18, unopened: 30, totalPacks: 9998, per100Now: 3.3333333, per100Launch: 0.18003600720144028, vsLaunch: 18.514814814814816, buyable: true, asOf: "2026-11-01T12:48:00Z" }
  it("reads the chase route buyable-only by default and relays rounded densities", async () => {
    const f = stubFetch([jsonRoute("/api/packs/chase", { rows: [row], total: 201 })])
    const r = await drive("get_pack_chase", { tier: "legendary", limit: 3 })
    const url = f.calls.find((c) => c.url.includes("/api/packs/chase"))!.url
    expect(url).toContain("collection=nba-top-shot")
    expect(url).toContain("buyableOnly=true")
    expect(url).toContain("sort=vsLaunch")
    expect(url).toContain("limit=3")
    expect(r).toMatchObject({ status: "ok", total_matching: 201, count: 1 })
    expect((r.rows as unknown[])[0]).toMatchObject({ per100_now: 3.33, vs_launch: 18.5, page: "/nba-top-shot/pack/dist/5727" })
    expect(String(r.rule)).toContain("not a per-pack chance")
  })
  it("buyableOnly false drops the filter", async () => {
    const f = stubFetch([jsonRoute("/api/packs/chase", { rows: [], total: 0 })])
    const r = await drive("get_pack_chase", { buyableOnly: false, tier: "ultimate" })
    expect(f.calls.find((c) => c.url.includes("/api/packs/chase"))!.url).not.toContain("buyableOnly")
    expect(r).toMatchObject({ status: "ok", count: 0 })
    expect(String(r.message)).toContain("No sealed Top Shot pack still holds a ultimate")
  })
  it("a failed read is an error, never 'no chase left'", async () => {
    stubFetch([jsonRoute("/api/packs/chase", { error: "unavailable" }, { status: 503, ok: false })])
    const r = await drive("get_pack_chase", {})
    expect(r).toMatchObject({ status: "error" })
    expect(r.rows).toBeUndefined()
    expect(JSON.stringify(r)).not.toMatch(/No (buyable|sealed)/)
  })
  it("on another collection is refused, never Top Shot's packs", async () => {
    stubFetch([jsonRoute("/api/packs/chase", { rows: [row], total: 1 })])
    script("get_pack_chase", {})
    await POST(post("which packs still have legendaries", { collectionId: "nfl-all-day" }))
    expect(toolResult()).toMatchObject({ status: "unsupported_collection" })
  })
})

describe("concierge — fetchPublicInsight response shapes", () => {
  it("passes a non-row payload through under data", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { headline: "hot", stats: { n: 3 } })])
    expect(r).toMatchObject({ status: "ok", headline: "hot" })
    expect(r.stats).toMatchObject({ n: 3 })
  })
  it("reports a non-200 board as a status error carrying the http status", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", {}, { status: 503, ok: false })])
    expect(r).toMatchObject({ status: "error", http_status: 503 })
  })
  it("surfaces a board-level error field as a status error", async () => {
    const r = await drive("get_market_movers", {}, [jsonRoute("/api/public/insights/market-pulse", { error: "board disabled" })])
    expect(r).toMatchObject({ status: "error", message: "board disabled" })
  })
})

describe("concierge — deal tools on a QUIET market (2026-10-18)", () => {
  // Cowork QA 10-18: the concierge called Golazos deals "fast-moving floors" on a
  // collection with ZERO indexed sales in 7 days. A deal tool's result now carries
  // the collection's indexed 7-day sale count when it is zero, so the model cannot
  // describe a frozen market as an active one.
  const deals = { data: { deals: [{ player: "Pedri", ask: 4, fmv: 7, discount_pct: 42 }], count: 1 }, error: null }
  const quiet = { slug: "laliga_golazos", sales_24h: 0, sales_7d: 0, sales_30d: 3, last_sale_at: "2026-10-01T18:00:00+00:00" }
  it("a zero-sale week attaches market_activity and forbids calling the market active", async () => {
    install({ "rpc:concierge_market_deals": deals })
    const r = await drive("search_live_deals", { team: "Barcelona", collectionId: "laliga-golazos" }, [
      jsonRoute("/api/public/insights/market-pulse", { rows: [{ slug: "nba_top_shot", sales_7d: 900 }, quiet] }),
    ])
    expect(r.market_activity).toMatchObject({ sales_indexed_7d: 0, last_indexed_sale_at: "2026-10-01T18:00:00+00:00" })
    expect(String((r.market_activity as { note: string }).note)).toMatch(/never call the market active/i)
    expect((r.deals as unknown[]).length).toBe(1)
  })
  it("an active collection gets NO market_activity block", async () => {
    install({ "rpc:concierge_market_deals": deals })
    const r = await drive("search_live_deals", { team: "Barcelona", collectionId: "laliga-golazos" }, [
      jsonRoute("/api/public/insights/market-pulse", { rows: [{ ...quiet, sales_7d: 12 }] }),
    ])
    expect(r.market_activity).toBeUndefined()
  })
  it("a FAILED market-pulse read adds nothing — no claim either way", async () => {
    install({ "rpc:concierge_market_deals": deals })
    const r = await drive("search_live_deals", { team: "Barcelona", collectionId: "laliga-golazos" }, [
      jsonRoute("/api/public/insights/market-pulse", {}, { status: 503, ok: false }),
    ])
    expect(r.market_activity).toBeUndefined()
    expect((r.deals as unknown[]).length).toBe(1)
  })
})

describe("concierge — get_top_sales on Panini (2026-10-19)", () => {
  // The board has served Panini since 10-10 (v_panini_top_sales); the concierge's
  // slug map never listed it and answered "doesn't cover this collection yet".
  it("maps panini-blockchain to the board's panini_blockchain filter and attaches the ingest-lag note", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    script("get_top_sales", { collectionId: "panini-blockchain" })
    await POST(post("biggest panini sales"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.count).toBe(1)
    expect(String(r.note)).toMatch(/days after they happen/)
    expect(f.calls.find((c) => c.url.includes("/top-sales"))!.url).toContain("collection=panini_blockchain")
    // Market Pulse has no Panini row by decision — it is never read for Panini.
    expect(f.calls.some((c) => c.url.includes("/market-pulse"))).toBe(false)
  })
  it("an empty Panini window says nothing is INDEXED yet — with the lag, never 'no sales'", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [] })])
    script("get_top_sales", { collectionId: "panini-blockchain" })
    await POST(post("biggest panini sales"))
    const r = toolResult()
    expect(String(r.note)).toMatch(/INDEXED/)
    expect(String(r.note)).toMatch(/under-counted/)
  })
  it("a failed board read stays an error, with no lag note dressing it up", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", {}, { status: 503, ok: false })])
    script("get_top_sales", { collectionId: "panini-blockchain" })
    await POST(post("biggest panini sales"))
    const r = toolResult()
    expect(r.status).toBe("error")
    expect(r.note).toBeUndefined()
  })
})

describe("concierge — get_premiums is scoped to the collection it names (2026-10-19)", () => {
  // Both public premium boards are Top Shot's. On a Panini page they answered a Panini
  // question with Top Shot's rows; on any other collection they still do — a substitution.
  it("Panini reads Panini's own boards, only the requested kind, and never the Top Shot board", async () => {
    install({
      panini_parallel_premiums: { data: [{ external_id: "packcard-1_1_1_1", player_name: "Messi", premium_mult: 3, parallel_confidence: "HIGH" }], error: null },
      panini_serial_premiums: { data: [{ external_id: "packcard-2_2_2_2", sku: "s", player_name: "Yamal", premium_mult: 4 }], error: null },
    })
    const f = stubFetch([jsonRoute("/api/public/insights/parallel-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "parallel", collectionId: "panini-blockchain" })
    await POST(post("panini parallel premiums"))
    const r = toolResult() as Record<string, any>
    expect(r.status).toBe("ok")
    expect(r.parallels[0].player).toBe("Messi")
    expect(r.serials).toBeUndefined()
    expect(JSON.stringify(r)).not.toMatch(/confidence/i)
    expect(f.calls.some((c) => c.url.includes("/parallel-premiums"))).toBe(false)
  })
  // 2026-10-28: All Day now HAS a serial board, so the "no board" case moved to Golazos (re-pinned, not inverted).
  it("a collection with no premiums board is refused, never answered with Top Shot's rows", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/serial-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "serial", collectionId: "laliga-golazos" })
    await POST(post("golazos serial premiums"))
    expect(toolResult()).toMatchObject({ status: "unsupported_collection" })
    expect(f.calls.some((c) => c.url.includes("/serial-premiums"))).toBe(false)
  })
  it("NFL All Day serial premiums read All Day's own board", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/serial-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "serial", collectionId: "nfl-all-day" })
    await POST(post("all day serial premiums"))
    expect(toolResult()).toMatchObject({ status: "ok" })
    expect(f.calls.find((c) => c.url.includes("/serial-premiums"))!.url).toContain("collection=nfl-all-day")
  })
  it("NFL All Day parallel premiums are refused — All Day has no parallels — never Top Shot's", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/parallel-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "parallel", collectionId: "nfl-all-day" })
    await POST(post("all day parallel premiums"))
    expect(toolResult()).toMatchObject({ status: "unsupported_collection" })
    expect(f.calls.some((c) => c.url.includes("/parallel-premiums"))).toBe(false)
  })
  it("CONTROL — Top Shot still reads the public board", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/serial-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "serial", collectionId: "nba-top-shot" })
    await POST(post("top shot serial premiums"))
    expect(toolResult()).toMatchObject({ status: "ok" })
    expect(f.calls.some((c) => c.url.includes("/serial-premiums"))).toBe(true)
  })
})

// 2026-10-25 replay: "Give me the collector report … the full rundown" hit the
// 1,024-token cap on its answer hop with NO text (the tokens went into a tool call
// that never finished), and the reader got "too complex for me … check the Sniper
// page". Now one more hop with tools off answers from what was gathered.
describe("concierge — an answer hop cut off with no text is retried once with tools off", () => {
  it("answers instead of the 'could not finish' fallback, and the retry disables tools", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    A.state.script = [
      { tools: [{ name: "get_top_sales", input: {} }] },
      { truncatedTool: { name: "get_top_sales", input: { limit: 50 } } },
      { text: "Here is the rundown." },
    ]
    A.state.cursor = 0
    const res = await POST(post("give me the full rundown"))
    const body = (await res.json()) as { response?: string }
    expect(body.response).toBe("Here is the rundown.")
    expect(body.response).not.toMatch(/Sniper|too complex|couldn't finish/)
    const third = A.createCalls[2] as unknown as { tool_choice?: { type: string }; max_tokens?: number }
    expect(third.tool_choice).toEqual({ type: "none" })
    expect(third.max_tokens).toBe(2048)
  })
  it("retries only once — a second empty cut-off ends in the honest fallback, not a loop", async () => {
    A.state.script = [
      { truncatedTool: { name: "get_top_sales", input: {} } },
      { truncatedTool: { name: "get_top_sales", input: {} } },
      { text: "never reached" },
    ]
    A.state.cursor = 0
    const res = await POST(post("give me the full rundown"))
    const body = (await res.json()) as { response?: string }
    expect(body.response).toMatch(/couldn't finish that answer in time/)
    expect(body.response).not.toMatch(/Sniper/)
    expect(A.createCalls.length).toBe(2)
  })
})

// 2026-10-25: the non-streamed path (Telegram / Discord bridge, smoke) kept only
// the LAST hop's text. "I can't find the team pages" → the model wrote the path,
// called a log tool, then wrote "I've also logged it" — and the user got only the
// last line. Every hop's text is kept now, as the streamed widget already does.
describe("concierge — the non-streamed reply keeps text written before a tool call", () => {
  it("the path written before the tool call reaches the user, then the closing line", async () => {
    stubFetch([jsonRoute("/api/public/insights/top-sales", { rows: [{ id: 1 }] })])
    A.state.script = [
      { preface: "Open the Team checklists card on the Overview → /teams → your team.", tools: [{ name: "get_top_sales", input: {} }] },
      { text: "I've also logged that it's hard to find." },
    ]
    A.state.cursor = 0
    const res = await POST(post("I can't easily find the team set pages"))
    const body = (await res.json()) as { response?: string }
    expect(body.response).toContain("Open the Team checklists card")
    expect(body.response).toContain("I've also logged")
    expect(body.response!.indexOf("Team checklists")).toBeLessThan(body.response!.indexOf("also logged"))
  })
})
