import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute, type FetchStub } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

// Concierge coverage for the two 2026-08-13 intent tools:
//
//   search_catalog    — the catalog INDEX, and the only tool that can answer a
//                       narrative query ("the Lillard game winner") because it
//                       searches moment descriptions rather than names alone.
//   get_price_history — long-horizon ACTUAL SALE PRINTS, the only path to a
//                       multi-year answer (fmv_snapshots only start 2026-03-31).
//
// The assertions here are weighted toward the honesty properties rather than
// the plumbing, because those are what a regression would quietly destroy:
//
//  * a FAILED search must stay `status: "error"` — degrading it to no_results
//    turns an outage into "we have no such moment", a claim about the catalog
//    manufactured from a database problem.
//  * a no_results narrative search must still carry `coverage` — descriptions
//    cover part of Top Shot and 0% of every other collection, so an empty
//    result is ambiguous and the model needs the figures to say which case it
//    is looking at.
//  * price history must stay labelled `basis: "actual_sale_prints"` with its
//    not_fmv note and its `grain`, because a sale median silently presented as
//    an FMV conflates what buyers paid with a model estimate.

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
    body: JSON.stringify({ message, sessionId: `cat-${Math.random()}`, ...extra }),
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
  await POST(post("catalog query"))
  return toolResult()
}

// A response shaped like the real /api/search route's 200.
const SEARCH_OK = {
  results: [
    {
      kind: "edition",
      label: "Damian Lillard",
      sublabel: "For the Win · 3 Pointer · RARE",
      href: "/nba-top-shot/edition/128%3A5147",
      collection: "nba-top-shot",
      collectionName: "NBA Top Shot",
      thumbnailUrl: null,
      editionCount: null,
    },
  ],
  meta: {
    q: "lillard game winner",
    count: 1,
    coverage: [
      { collection_slug: "nba_top_shot", searchable_editions: 13203, with_description: 5885, pct: "44.6" },
      { collection_slug: "nfl_all_day", searchable_editions: 6190, with_description: 0, pct: "0.0" },
    ],
    note: "Descriptions cover only part of the catalog — nba_top_shot 44.6% (5885/13203)",
  },
}

describe("concierge — search_catalog", () => {
  it("forwards the query, scope and clamped limit, and returns linkable hits", async () => {
    const f = stubFetch([jsonRoute("/api/search", SEARCH_OK)])
    script("search_catalog", { query: "lillard game winner", collection: "nba-top-shot", limit: 99 })
    await POST(post("find it"))
    const r = toolResult()

    expect(r).toMatchObject({ status: "ok", count: 1 })
    const url = f.calls.find((c) => c.url.includes("/api/search"))!.url
    expect(url).toContain("q=lillard+game+winner")
    expect(url).toContain("collection=nba-top-shot")
    // 99 clamps to the documented ceiling of 30 rather than being passed through.
    expect(url).toContain("limit=30")

    const hit = (r.results as Array<Record<string, unknown>>)[0]
    // The slug is what get_price_history needs, and it must arrive DECODED —
    // the href carries it percent-encoded because ':' is encoded into the path.
    expect(hit.slug).toBe("128:5147")
    expect(hit.url).toContain("/nba-top-shot/edition/128%3A5147")
    expect(hit.kind).toBe("edition")
  })

  it("defaults the scope to the page's active collection", async () => {
    const f = stubFetch([jsonRoute("/api/search", SEARCH_OK)])
    script("search_catalog", { query: "lillard" })
    await POST(post("find it", { collectionId: "nba-top-shot" }))
    expect(f.calls.find((c) => c.url.includes("/api/search"))!.url).toContain("collection=nba-top-shot")
  })

  it("carries the live coverage figures through on a SUCCESSFUL search", async () => {
    const r = await drive("search_catalog", { query: "lillard game winner" }, [jsonRoute("/api/search", SEARCH_OK)])
    expect(r.coverage).toBeTruthy()
    expect(r.coverage_note).toContain("44.6")
  })

  // The honesty property that matters most on this tool. An empty narrative
  // result is ambiguous between "no such moment" and "no description on file",
  // and the model can only tell them apart if the coverage survives the
  // no_results branch.
  it("keeps coverage attached on no_results so an empty narrative search stays ambiguous", async () => {
    const r = await drive("search_catalog", { query: "triple backflip dunk" }, [
      jsonRoute("/api/search", { results: [], meta: { coverage: SEARCH_OK.meta.coverage, note: SEARCH_OK.meta.note } }),
    ])
    expect(r.status).toBe("no_results")
    expect(r.coverage).toBeTruthy()
    expect(r.coverage_note).toContain("44.6")
    expect(String(r.message)).toMatch(/does not exist/i)
  })

  // A failed read must never render as data. If this degrades to no_results the
  // model will report "we have no such moment" during a database outage.
  it("reports a 503 as an ERROR, never as an empty catalog", async () => {
    const r = await drive("search_catalog", { query: "lillard" }, [
      jsonRoute("/api/search", { error: "Search is unavailable right now.", code: "search_unavailable" }, { status: 503, ok: false }),
    ])
    expect(r.status).toBe("error")
    expect(r.status).not.toBe("no_results")
    expect(r.message).toBe("Search is unavailable right now.")
    expect(r.http_status).toBe(503)
  })

  it("rejects a too-short query before spending a fetch", async () => {
    const f = stubFetch([jsonRoute("/api/search", SEARCH_OK)])
    script("search_catalog", { query: "a" })
    await POST(post("find it"))
    expect(toolResult().status).toBe("error")
    expect(f.calls.some((c) => c.url.includes("/api/search"))).toBe(false)
  })
})

const HISTORY_ROWS = [
  { grain: "week", bucket: "2025-08-18", low_usd: 34, high_usd: 36, median_usd: 35, sales_count: 2 },
  { grain: "week", bucket: "2026-07-20", low_usd: 17, high_usd: 25, median_usd: 21, sales_count: 2 },
]

describe("concierge — get_price_history", () => {
  it("queries the sale-history part with the slug, collection and window", async () => {
    const f = stubFetch([jsonRoute("/api/entity/edition", HISTORY_ROWS)])
    script("get_price_history", { editionSlug: "128:5147", collection: "nba-top-shot", days: 365 })
    await POST(post("history"))
    const r = toolResult()

    expect(r).toMatchObject({ status: "ok", buckets: 2, grain: "week" })
    const url = f.calls.find((c) => c.url.includes("/api/entity/edition"))!.url
    expect(url).toContain("part=sale-history")
    expect(url).toContain("slug=128%3A5147")
    expect(url).toContain("collection=nba-top-shot")
    expect(url).toContain("days=365")
    expect(r.first_bucket).toBe("2025-08-18")
    expect(r.last_bucket).toBe("2026-07-20")
  })

  // The conflation guard. `basis` + `not_fmv` are what stop the model
  // presenting a sale median as an FMV, and `grain` is what stops it implying
  // daily resolution on a multi-year series.
  it("labels the series as sale prints, not FMV, and states its grain", async () => {
    const r = await drive("get_price_history", { editionSlug: "128:5147", collection: "nba-top-shot" }, [
      jsonRoute("/api/entity/edition", HISTORY_ROWS),
    ])
    expect(r.basis).toBe("actual_sale_prints")
    expect(String(r.not_fmv)).toMatch(/NOT FMV/i)
    expect(r.grain).toBe("week")
  })

  it("passes days=0 through as all-time rather than falling back to the default", async () => {
    const f = stubFetch([jsonRoute("/api/entity/edition", HISTORY_ROWS)])
    script("get_price_history", { editionSlug: "128:5147", collection: "nba-top-shot", days: 0 })
    await POST(post("history"))
    expect(f.calls.find((c) => c.url.includes("/api/entity/edition"))!.url).toContain("days=0")
  })

  it("defaults the collection to the active page context", async () => {
    const f = stubFetch([jsonRoute("/api/entity/edition", HISTORY_ROWS)])
    script("get_price_history", { editionSlug: "128:5147" })
    await POST(post("history", { collectionId: "nba-top-shot" }))
    expect(f.calls.find((c) => c.url.includes("/api/entity/edition"))!.url).toContain("collection=nba-top-shot")
  })

  it("treats an empty series as no_results and points at the all-time window", async () => {
    const r = await drive("get_price_history", { editionSlug: "9:9", collection: "nba-top-shot", days: 30 }, [
      jsonRoute("/api/entity/edition", []),
    ])
    expect(r.status).toBe("no_results")
    expect(String(r.message)).toContain("days=0")
  })

  it("reports an upstream failure as an error rather than an empty history", async () => {
    const r = await drive("get_price_history", { editionSlug: "128:5147", collection: "nba-top-shot" }, [
      jsonRoute("/api/entity/edition", { error: "The database is under heavy load." }, { status: 503, ok: false }),
    ])
    expect(r.status).toBe("error")
    expect(r.status).not.toBe("no_results")
    expect(r.message).toBe("The database is under heavy load.")
  })

  it("requires an edition slug and a collection before spending a fetch", async () => {
    const f = stubFetch([jsonRoute("/api/entity/edition", HISTORY_ROWS)])
    script("get_price_history", { editionSlug: "" })
    await POST(post("history"))
    expect(String(toolResult().message)).toContain("editionSlug")

    script("get_price_history", { editionSlug: "128:5147" })
    await POST(post("history"))
    expect(String(toolResult().message)).toContain("collection")

    expect(f.calls.some((c) => c.url.includes("/api/entity/edition"))).toBe(false)
  })
})

// ── find_quirky_serials ──────────────────────────────────────────────────────
// Novelty serial finds. The properties that matter are the two honesty ones:
// the tool must never imply value (Trevor: "they're so niche they don't get a
// value bump, but they're just fun if you find them"), and a wallet too large
// to scan fully must report a LOWER BOUND rather than a confident total.

function wmcPage(rows: unknown[]) {
  // A chainable wmc query stub ending in .range().
  const q: any = {}
  for (const m of ["select", "eq", "not", "order"]) q[m] = () => q
  q.range = (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null })
  return q
}

function installWmc(rows: unknown[], opts: { resolve?: unknown } = {}) {
  A.sb = {
    from: () => wmcPage(rows),
    rpc: async () => ({ data: opts.resolve ?? { found: false }, error: null }),
  }
}

describe("concierge — find_quirky_serials", () => {
  it("returns quirky finds with their explanations and disclaims any price effect", async () => {
    installWmc([
      { serial_number: 1221, mint_count: 3000, player_name: "Damian Lillard", set_name: "Base Set", edition_key: "1:1" },
      { serial_number: 420, mint_count: 3000, player_name: "Ja Morant", set_name: "Base Set", edition_key: "1:2" },
      { serial_number: 4817, mint_count: 3000, player_name: "Ordinary Guy", set_name: "Base Set", edition_key: "1:3" },
    ])
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef" })
    await POST(post("fun serials"))
    const r = toolResult()

    expect(r.status).toBe("ok")
    // The ordinary serial is excluded; only the two quirky ones come back.
    expect(r.total_found).toBe(2)
    const kinds = (r.findings as any[]).flatMap((f) => f.quirks.map((q: any) => q.kind))
    expect(kinds).toContain("palindrome")
    expect(kinds).toContain("meme")
    // Every quirk explains itself — "you have a palindrome" is unverifiable.
    for (const f of r.findings as any[]) {
      for (const q of f.quirks) expect(q.why).toBeTruthy()
    }
    // The no-price-claim disclaimer must travel with the result.
    expect(String(r.not_a_price_signal)).toMatch(/NO value premium/i)
  })

  it("reports a complete scan as complete", async () => {
    installWmc([{ serial_number: 888, mint_count: 900, player_name: "P", set_name: "S", edition_key: "1:1" }])
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef" })
    await POST(post("fun serials"))
    const r = toolResult()
    expect(r.scan_complete).toBe(true)
    expect(r.count_is_lower_bound).toBe(false)
  })

  // ⚠ The count-honesty property. PostgREST caps a read at 1,000 rows, so a
  // large wallet is paginated; when the page budget is exhausted the total is a
  // LOWER BOUND and must be reported as one. A confident "you have N quirky
  // serials" computed from a partial scan is the silently-sliced-ranking bug.
  it("reports a partial scan as a lower bound, never as a complete total", async () => {
    // Every page comes back FULL, so the pager never sees a short page and
    // exhausts maxPages — the real truncation condition.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      serial_number: 121,
      mint_count: 3000,
      player_name: `P${i}`,
      set_name: "S",
      edition_key: `1:${i}`,
    }))
    A.sb = {
      from: () => {
        const q: any = {}
        for (const m of ["select", "eq", "not", "order"]) q[m] = () => q
        q.range = () => Promise.resolve({ data: fullPage, error: null })
        return q
      },
      rpc: async () => ({ data: { found: false }, error: null }),
    }
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef" })
    await POST(post("fun serials"))
    const r = toolResult()
    expect(r.status).toBe("ok")
    expect(r.scan_complete).toBe(false)
    expect(r.count_is_lower_bound).toBe(true)
  })

  it("treats a wallet with no quirks as a real answer, not a failure", async () => {
    installWmc([{ serial_number: 4817, mint_count: 3000, player_name: "P", set_name: "S", edition_key: "1:1" }])
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef" })
    await POST(post("fun serials"))
    const r = toolResult()
    expect(r.status).toBe("no_results")
    expect(r.scan_complete).toBe(true)
  })

  // A failed read must never render as "you have no quirky serials".
  it("reports a read failure as an error, not an empty wallet", async () => {
    A.sb = {
      from: () => {
        const q: any = {}
        for (const m of ["select", "eq", "not", "order"]) q[m] = () => q
        q.range = () => Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } })
        return q
      },
      rpc: async () => ({ data: { found: false }, error: null }),
    }
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef" })
    await POST(post("fun serials"))
    const r = toolResult()
    expect(r.status).toBe("error")
    expect(r.status).not.toBe("no_results")
    // Driver text must not reach the model verbatim.
    expect(String(r.message)).not.toContain("canceling statement")
  })

  it("rejects an unknown collection and an empty wallet before querying", async () => {
    installWmc([])
    script("find_quirky_serials", { walletAddress: "0x1234567890abcdef", collectionId: "not-a-collection" })
    await POST(post("fun serials"))
    expect(String(toolResult().message)).toContain("Unknown collection")

    script("find_quirky_serials", { walletAddress: "" })
    await POST(post("fun serials"))
    expect(toolResult().status).toBe("error")
  })

  it("reports an unresolvable username rather than guessing a wallet", async () => {
    installWmc([], { resolve: { found: false } })
    script("find_quirky_serials", { walletAddress: "someuser" })
    await POST(post("fun serials"))
    expect(toolResult().status).toBe("username_not_resolved")
  })
})
