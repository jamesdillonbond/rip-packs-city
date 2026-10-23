import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
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
  it("rejects an unknown ecosystem metric", async () => {
    expect(await drive("get_ecosystem_stat", { metric: "nope" })).toMatchObject({ status: "error" })
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
  it("a collection with no premiums board is refused, never answered with Top Shot's rows", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/serial-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "serial", collectionId: "nfl-all-day" })
    await POST(post("all day serial premiums"))
    expect(toolResult()).toMatchObject({ status: "unsupported_collection" })
    expect(f.calls.some((c) => c.url.includes("/serial-premiums"))).toBe(false)
  })
  it("CONTROL — Top Shot still reads the public board", async () => {
    const f = stubFetch([jsonRoute("/api/public/insights/serial-premiums", { rows: [{ x: 1 }] })])
    script("get_premiums", { kind: "serial", collectionId: "nba-top-shot" })
    await POST(post("top shot serial premiums"))
    expect(toolResult()).toMatchObject({ status: "ok" })
    expect(f.calls.some((c) => c.url.includes("/serial-premiums"))).toBe(true)
  })
})
