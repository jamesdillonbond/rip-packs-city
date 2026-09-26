// Concierge player identity (batch 55, 2026-09-25). The property under test:
// the concierge never treats a NAME as the PERSON. Every player tool resolves
// the typed spelling through public.resolve_player_name, an alias or the
// league's spelling reaches the right row, a same-name pair (father / son,
// or two unrelated players) is either disambiguated or DECLARED ambiguous —
// never pooled, never guessed — and a failed resolver read is the fourth
// state ("unavailable"), never "no such player".

import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextRequest } from "next/server"
import { resolvePlayerName, identityContextFor, type PlayerResolution } from "@/lib/concierge/player-identity"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import type { ScriptTurn } from "./helpers/anthropic-fixture"

const ROOT = join(__dirname, "..")
const AD_UUID = "dee28451-5d62-409e-a1ad-a83f763ac070"

// ── the resolver's four states, at the wrapper ─────────────────────────────

const father = {
  player: { id: "p-sr", name: "Marvin Harrison", slug: "marvin-harrison", team: "Indianapolis Colts", edition_count: 5 },
  aliases: [],
  identity: { league: "nfl", league_player_id: "00-0007024", espn_id: "939", league_name: "Marvin Harrison", league_name_differs: false, position: "WR", status: "RET", rookie_season: 1996, last_season: 2008, latest_team: "IND", matched_by: "name", stats_seasons: 0, stats_refreshed_at: null },
  relations: [{ relation: "parent_of", name: "Marvin Harrison Jr.", slug: "marvin-harrison-jr", note: "Marvin Harrison Jr. is the son of Hall of Famer Marvin Harrison" }],
  matched_query_as: "exact",
}
const son = {
  player: { id: "p-jr", name: "Marvin Harrison Jr.", slug: "marvin-harrison-jr", team: "Arizona Cardinals", edition_count: 11 },
  aliases: [],
  identity: { league: "nfl", league_player_id: "00-0039849", espn_id: "4432708", league_name: "Marvin Harrison Jr.", league_name_differs: false, position: "WR", status: "ACT", rookie_season: 2024, last_season: 2026, latest_team: "ARI", matched_by: "name", stats_seasons: 2, stats_refreshed_at: "2026-09-25T20:00:00Z" },
  relations: [{ relation: "child_of", name: "Marvin Harrison", slug: "marvin-harrison", note: "Marvin Harrison Jr. is the son of Hall of Famer Marvin Harrison" }],
  matched_query_as: "base_name",
}
const harrisonOne: PlayerResolution = { status: "one", query: "Marvin Harrison", query_slug: "marvin-harrison", matched_via: "exact", ...father, namesakes: [son], note: "Another player in this collection shares this base name" }

const flaccoOne: PlayerResolution = {
  status: "one", query: "Joseph Flacco", query_slug: "joseph-flacco", matched_via: "alias",
  player: { id: "p-flacco", name: "Joe Flacco", slug: "joe-flacco", team: "Cleveland Browns", edition_count: 9 },
  aliases: [{ slug: "joseph-flacco", note: "batch 51" }],
  identity: { league: "nfl", league_player_id: "00-0026158", espn_id: "11252", league_name: "Joe Flacco", league_name_differs: false, position: "QB", status: "ACT", rookie_season: 2008, last_season: 2026, latest_team: "CLE", matched_by: "name", stats_seasons: 3, stats_refreshed_at: null },
  relations: [], matched_query_as: "alias", namesakes: [],
}

const murphyAmbiguous: PlayerResolution = {
  status: "ambiguous", query: "Byron Murphy", query_slug: "byron-murphy",
  candidates: [
    { player: { id: "p-dt", name: "Byron Murphy II", slug: "byron-murphy-ii", team: "Seattle Seahawks", edition_count: 5 }, aliases: [], identity: null, relations: [{ relation: "unrelated_namesake", name: "Byron Murphy Jr.", slug: "byron-murphy-jr", note: "Unrelated" }], matched_query_as: "base_name" },
    { player: { id: "p-cb", name: "Byron Murphy Jr.", slug: "byron-murphy-jr", team: "Minnesota Vikings", edition_count: 2 }, aliases: [], identity: null, relations: [{ relation: "unrelated_namesake", name: "Byron Murphy II", slug: "byron-murphy-ii", note: "Unrelated" }], matched_query_as: "base_name" },
  ],
  note: "Several people match — never pool",
}

describe("resolvePlayerName — the wrapper keeps four states apart", () => {
  it("a driver error is 'unavailable', never 'none'", async () => {
    const sb = { rpc: async () => ({ data: null, error: { message: "canceling statement due to statement timeout" } }) }
    const r = await resolvePlayerName(sb, AD_UUID, "Joe Flacco")
    expect(r.status).toBe("unavailable")
    expect(identityContextFor(r).note).toMatch(/FAILED/)
  })
  it("a payload with no verdict is 'unavailable'; a thrown driver too", async () => {
    expect((await resolvePlayerName({ rpc: async () => ({ data: [], error: null }) }, AD_UUID, "x")).status).toBe("unavailable")
    expect((await resolvePlayerName({ rpc: async () => { throw new Error("boom") } }, AD_UUID, "x")).status).toBe("unavailable")
  })
  it("no collection in scope cannot resolve (and says so); a blank name is 'none' without a read", async () => {
    const rpc = vi.fn()
    expect((await resolvePlayerName({ rpc }, null, "Joe Flacco")).status).toBe("unavailable")
    expect((await resolvePlayerName({ rpc }, AD_UUID, "   ")).status).toBe("none")
    expect(rpc).not.toHaveBeenCalled()
  })
  it("passes the collection and the name to the RPC and hands the verdict back", async () => {
    const rpc = vi.fn(async () => ({ data: flaccoOne, error: null }))
    const r = await resolvePlayerName({ rpc }, AD_UUID, "  Joseph Flacco ")
    expect(rpc).toHaveBeenCalledWith("resolve_player_name", { p_collection_id: AD_UUID, p_name: "Joseph Flacco" })
    expect(r).toBe(flaccoOne)
  })
})

describe("identityContextFor — what the model is told", () => {
  it("the father: the son is a namesake with the RECORDED relation, and the warning says which person was priced", () => {
    const ctx = identityContextFor(harrisonOne) as { status: string; resolved: Record<string, unknown>; namesakes: Array<Record<string, unknown>>; warnings: string[] }
    expect(ctx.status).toBe("one")
    expect(ctx.resolved).toMatchObject({ name: "Marvin Harrison", player_slug: "marvin-harrison", edition_count: 5 })
    expect(ctx.resolved.identity).toMatchObject({ league_player_id: "00-0007024", seasons: "1996–2008", stats_available: false })
    expect(ctx.namesakes).toHaveLength(1)
    expect(ctx.namesakes[0]).toMatchObject({ name: "Marvin Harrison Jr.", relation_to_resolved: "Marvin Harrison Jr. is the CHILD of Marvin Harrison" })
    expect(ctx.namesakes[0].identity).toMatchObject({ stats_available: true, stats_seasons: 2 })
    expect(ctx.warnings.join(" ")).toMatch(/for Marvin Harrison ONLY/)
    expect(ctx.warnings.join(" ")).toMatch(/never pool/)
  })
  it("an alias resolution names the catalog spelling; a namesake with no recorded relation says kinship NOT recorded", () => {
    const ctx = identityContextFor(flaccoOne) as { warnings: string[]; namesakes: unknown[] }
    expect(ctx.warnings[0]).toMatch(/"Joseph Flacco" resolved to Joe Flacco via a registered alias/)
    expect(ctx.namesakes).toEqual([])
    const stranger: PlayerResolution = { ...harrisonOne, relations: [], namesakes: [{ ...son, relations: [] }] }
    const c2 = identityContextFor(stranger) as { namesakes: Array<{ relation_to_resolved: string }> }
    expect(c2.namesakes[0].relation_to_resolved).toMatch(/kinship NOT recorded — do not assert/)
  })
  it("a former name is surfaced as a name change, and the league's spelling is named when it differs", () => {
    const chosen: PlayerResolution = {
      ...flaccoOne, query: "Robby Anderson", query_slug: "robby-anderson", matched_via: "exact",
      player: { id: "p-ra", name: "Robby Anderson", slug: "robby-anderson", team: "Carolina Panthers", edition_count: 2 },
      identity: { ...flaccoOne.identity!, league_name: "Robbie Chosen", league_name_differs: true },
      relations: [{ relation: "also_known_as", name: "Robbie Chosen", slug: "robbie-chosen", note: "Changed his name to Robbie Chosen in 2022" }],
    }
    const ctx = identityContextFor(chosen) as { warnings: string[]; resolved: { identity: { league_name?: string } } }
    expect(ctx.warnings.join("\n")).toMatch(/The league lists this player as "Robbie Chosen"/)
    expect(ctx.warnings.join("\n")).toMatch(/has also gone by "Robbie Chosen" — Changed his name/)
    expect(ctx.resolved.identity.league_name).toBe("Robbie Chosen")
  })
  it("ambiguous carries every candidate with its relations; none carries nothing invented", () => {
    const ctx = identityContextFor(murphyAmbiguous) as { status: string; candidates: Array<{ name: string; relations: Array<{ relation: string }> }> }
    expect(ctx.status).toBe("ambiguous")
    expect(ctx.candidates.map((c) => c.name)).toEqual(["Byron Murphy II", "Byron Murphy Jr."])
    expect(ctx.candidates[0].relations[0].relation).toBe("unrelated_namesake")
    expect(identityContextFor({ status: "none", query: "Nobody" })).toMatchObject({ status: "none", query: "Nobody" })
  })
})

// ── the route: get_player_editions / get_fmv / resolve_player_name ─────────

const A = vi.hoisted(() => ({
  state: { script: [] as ScriptTurn[], cursor: 0 },
  createCalls: [] as Array<{ system: Array<{ text: string }>; messages: Array<{ role: string; content: unknown }> }>,
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

function install(fixtures: Parameters<typeof makeInstrumentedSupabaseFixture>[0]) {
  const inst = makeInstrumentedSupabaseFixture(fixtures)
  A.sb = inst.fixture
  return inst
}
function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://t/api/support-chat", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: "tell me about this player", sessionId: `e-${Math.random()}`, ...body }),
  })
}
function toolResult(): Record<string, unknown> {
  const blocks = A.createCalls.at(-1)?.messages.at(-1)?.content as Array<{ type: string; content: string }>
  const tr = blocks?.find((b) => b.type === "tool_result")
  if (!tr) throw new Error("no tool_result")
  return JSON.parse(tr.content)
}
function script(tool: string, input: Record<string, unknown>) {
  A.state.script = [{ tools: [{ name: tool, input }] }, { text: "done" }]
  A.state.cursor = 0
  A.createCalls.length = 0
}
beforeEach(() => {
  install({})
  A.createCalls.length = 0
  A.state.script = [{ text: "ok" }]
  A.state.cursor = 0
})

const flaccoEditions = [
  { player_name: "Joe Flacco", team_name: "Cleveland Browns", set_name: "Base", tier: "COMMON", route_slug: "ad:1", series_label: "2023", circulation_count: 1000, fmv_usd: 4, fmv_confidence: "HIGH", fmv_computed_at: "2026-09-25T00:00:00Z", floor_usd: 3 },
]

describe("get_player_editions resolves the name first", () => {
  it("an alias reaches the right row: the RPC is called with the RESOLVED slug and the answer carries player_identity", async () => {
    const inst = install({
      "rpc:resolve_player_name": { data: flaccoOne, error: null },
      "rpc:get_player_editions": { data: flaccoEditions, error: null },
    })
    script("get_player_editions", { playerName: "Joseph Flacco", collectionId: "nfl-all-day" })
    await POST(post({ collectionId: "nfl-all-day" }))
    const r = toolResult() as { player: string; player_url: string; player_identity: { status: string; matched_via: string; warnings: string[] } }
    expect(r).toMatchObject({ status: "ok", player: "Joe Flacco", total_editions: 1 })
    expect(r.player_url).toMatch(/\/nfl-all-day\/player\/joe-flacco$/)
    const call = inst.rpcCalls.find((c) => c.name === "get_player_editions")!
    expect(call.args).toMatchObject({ p_collection_id: AD_UUID, p_player_slug: "joe-flacco" })
    expect(inst.rpcCalls.find((c) => c.name === "resolve_player_name")!.args).toMatchObject({ p_collection_id: AD_UUID, p_name: "Joseph Flacco" })
    expect(r.player_identity).toMatchObject({ status: "one", matched_via: "alias" })
    expect(r.player_identity.warnings[0]).toMatch(/resolved to Joe Flacco via a registered alias/)
  })
  it("the father: editions are HIS, and the son rides along as a namesake with the recorded relation", async () => {
    const inst = install({
      "rpc:resolve_player_name": { data: harrisonOne, error: null },
      "rpc:get_player_editions": { data: [{ ...flaccoEditions[0], player_name: "Marvin Harrison", team_name: "Indianapolis Colts" }], error: null },
    })
    script("get_player_editions", { playerName: "Marvin Harrison", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { player_identity: { namesakes: Array<{ name: string; relation_to_resolved: string }>; warnings: string[] } }
    expect(r).toMatchObject({ status: "ok", player: "Marvin Harrison" })
    expect(inst.rpcCalls.find((c) => c.name === "get_player_editions")!.args).toMatchObject({ p_player_slug: "marvin-harrison" })
    expect(r.player_identity.namesakes[0]).toMatchObject({ name: "Marvin Harrison Jr.", relation_to_resolved: "Marvin Harrison Jr. is the CHILD of Marvin Harrison" })
    expect(r.player_identity.warnings.join(" ")).toMatch(/Marvin Harrison ONLY/)
  })
  it("a suffixed name's slug is handed to the RPC and the URL VERBATIM — the site keeps the dash a trailing '.' leaves (batch 57: 0 rows + a 404 otherwise)", async () => {
    const jr: PlayerResolution = { status: "one", query: "Marvin Harrison Jr.", query_slug: "marvin-harrison-jr", matched_via: "exact", ...son, player: { ...son.player, slug: "marvin-harrison-jr-" }, namesakes: [father] }
    const inst = install({
      "rpc:resolve_player_name": { data: jr, error: null },
      "rpc:get_player_editions": { data: [{ ...flaccoEditions[0], player_name: "Marvin Harrison Jr.", team_name: "Arizona Cardinals" }], error: null },
    })
    script("get_player_editions", { playerName: "Marvin Harrison Jr.", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { player_url: string; player_identity: { namesakes: Array<{ relation_to_resolved: string }> } }
    expect(inst.rpcCalls.find((c) => c.name === "get_player_editions")!.args).toMatchObject({ p_player_slug: "marvin-harrison-jr-" })
    expect(r.player_url).toMatch(/\/player\/marvin-harrison-jr-$/)
    // the relation still resolves across the trailing dash
    expect(r.player_identity.namesakes[0].relation_to_resolved).toBe("Marvin Harrison is the PARENT of Marvin Harrison Jr.")
  })
  it("two unrelated Byron Murphys: AMBIGUOUS, the candidates come back, and NO editions RPC runs", async () => {
    const inst = install({ "rpc:resolve_player_name": { data: murphyAmbiguous, error: null }, "rpc:get_player_editions": { data: flaccoEditions, error: null } })
    script("get_player_editions", { playerName: "Byron Murphy", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; player_identity: { candidates: Array<{ name: string }> }; message: string }
    expect(r.status).toBe("ambiguous")
    expect(r.player_identity.candidates.map((c) => c.name)).toEqual(["Byron Murphy II", "Byron Murphy Jr."])
    expect(r.message).toMatch(/Never merge/)
    expect(inst.rpcCalls.map((c) => c.name)).toEqual(["resolve_player_name"])
  })
  it("a FAILED resolver read falls back to the typed spelling and SAYS the identity check failed — it is not 'no such player'", async () => {
    install({
      "rpc:resolve_player_name": { data: null, error: { message: "canceling statement due to statement timeout" } },
      "rpc:get_player_editions": { data: flaccoEditions, error: null },
    })
    script("get_player_editions", { playerName: "Joe Flacco", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { player_identity: { status: string; note: string } }
    expect(r).toMatchObject({ status: "ok", player: "Joe Flacco" })
    expect(r.player_identity.status).toBe("unavailable")
    expect(r.player_identity.note).toMatch(/FAILED/)
  })
  it("'none' from the resolver + an empty RPC is a catalog miss that forbids substitution; 'one' + empty says the player exists without priced moments", async () => {
    install({ "rpc:resolve_player_name": { data: { status: "none", query: "Nobody Here", query_slug: "nobody-here" }, error: null }, "rpc:get_player_editions": { data: [], error: null } })
    script("get_player_editions", { playerName: "Nobody Here", collectionId: "nfl-all-day" })
    await POST(post({}))
    let r = toolResult() as { status: string; message: string }
    expect(r.status).toBe("no_results")
    expect(r.message).toMatch(/Do NOT substitute/)
    install({ "rpc:resolve_player_name": { data: flaccoOne, error: null }, "rpc:get_player_editions": { data: [], error: null } })
    script("get_player_editions", { playerName: "Joseph Flacco", collectionId: "nfl-all-day" })
    await POST(post({}))
    r = toolResult() as { status: string; message: string }
    expect(r.status).toBe("no_results")
    expect(r.message).toMatch(/resolved to Joe Flacco/)
  })
})

describe("get_fmv with a player name", () => {
  const editionRows = [
    { id: "e1", external_id: "ad:1", player_name: "Marvin Harrison", set_name: "Base", tier: "COMMON", collection_id: AD_UUID },
    { id: "e2", external_id: "ad:2", player_name: "Marvin Harrison", set_name: "Base", tier: "COMMON", collection_id: AD_UUID },
  ]
  const snaps = [
    { edition_id: "e1", fmv_usd: 10, confidence: "HIGH", computed_at: "2026-09-01T00:00:00Z" },
    { edition_id: "e2", fmv_usd: 30, confidence: "HIGH", computed_at: "2026-09-02T00:00:00Z" },
  ]
  it("a resolved name prices ONE person and the distribution carries player_identity with the namesake warning", async () => {
    install({
      "rpc:resolve_player_name": { data: harrisonOne, error: null },
      editions: [{ count: 2, data: null, error: null }, { data: editionRows, error: null }],
      "rpc:get_editions_latest_fmv": { data: snaps, error: null },
    })
    script("get_fmv", { playerName: "Marvin Harrison", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; mode?: string; player_identity: { status: string; namesakes: Array<{ name: string }>; warnings: string[] } }
    expect(r.status).toBe("ok")
    expect(r.player_identity.status).toBe("one")
    expect(r.player_identity.namesakes[0].name).toBe("Marvin Harrison Jr.")
    expect(r.player_identity.warnings.join(" ")).toMatch(/never pool/)
  })
  it("an ambiguous name returns the candidates and NO distribution — two people are never priced as one", async () => {
    const inst = install({
      "rpc:resolve_player_name": { data: murphyAmbiguous, error: null },
      editions: { data: editionRows, error: null },
      "rpc:get_editions_latest_fmv": { data: snaps, error: null },
    })
    script("get_fmv", { playerName: "Byron Murphy", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; message: string; median_fmv?: unknown; p50?: unknown }
    expect(r.status).toBe("ambiguous")
    expect(r.message).toMatch(/nothing was searched or priced/)
    expect(r.p50).toBeUndefined()
    expect(r.median_fmv).toBeUndefined()
    expect(inst.rpcCalls.map((c) => c.name)).not.toContain("get_editions_latest_fmv")
  })
})

describe("the label-keyed tools are scoped to the PERSON (batch 59)", () => {
  const flaccoLabels: PlayerResolution = { ...flaccoOne, player: { ...flaccoOne.player, labels: ["Joe Flacco", "Joseph Flacco"] } }
  it("search_catalog_deals filters cached_listings on the person's edition LABELS, not an ILIKE of the typed name; the answer carries player_identity", async () => {
    const inst = install({
      "rpc:resolve_player_name": { data: flaccoLabels, error: null },
      cached_listings: { data: [{ player_name: "Joseph Flacco", set_name: "Base", tier: "COMMON", serial_number: 5, circulation_count: 100, ask_price: 3, fmv: 4, discount: 25, badge_slugs: [], buy_url: "u", collection_id: AD_UUID }], error: null },
    })
    // the fixture ignores filter args, so assert on the filter CALLS the builder saw
    const seen: Array<[string, unknown, unknown]> = []
    const from = (inst.fixture as { from: (t: string) => Record<string, unknown> }).from
    ;(inst.fixture as { from: unknown }).from = (t: string) => {
      const b = from(t)
      for (const m of ["in", "ilike"]) {
        const orig = b[m] as (...a: unknown[]) => unknown
        b[m] = (...a: unknown[]) => { seen.push([`${t}.${m}`, a[0], a[1]]); return orig(...a) }
      }
      return b
    }
    A.sb = inst.fixture
    script("search_catalog_deals", { player: "Joseph Flacco", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; player_identity: { status: string } }
    expect(r.status).toBe("ok")
    expect(r.player_identity.status).toBe("one")
    expect(seen).toContainEqual(["cached_listings.in", "player_name", ["Joe Flacco", "Joseph Flacco"]])
    expect(seen.some(([k, col]) => k === "cached_listings.ilike" && col === "player_name")).toBe(false)
  })
  it("an ambiguous name on a deal board answers with the candidates and searches NOTHING", async () => {
    const inst = install({ "rpc:resolve_player_name": { data: murphyAmbiguous, error: null }, cached_listings: { data: [{ player_name: "Byron Murphy II" }], error: null } })
    script("search_catalog_deals", { player: "Byron Murphy", collectionId: "nfl-all-day" })
    await POST(post({}))
    expect(toolResult()).toMatchObject({ status: "ambiguous" })
    expect(inst.rpcCalls.map((c) => c.name)).toEqual(["resolve_player_name"])
  })
  it("an UNRESOLVED name keeps the tool's own ILIKE (a partial still searches) and says the identity check found nobody", async () => {
    const seen: string[] = []
    const inst = install({ "rpc:resolve_player_name": { data: { status: "none", query: "Flac" }, error: null }, cached_listings: { data: [], error: null } })
    const from = (inst.fixture as { from: (t: string) => Record<string, unknown> }).from
    ;(inst.fixture as { from: unknown }).from = (t: string) => { const b = from(t); const o = b.ilike as (...a: unknown[]) => unknown; b.ilike = (...a: unknown[]) => { seen.push(`${t}.ilike:${a[0]}=${a[1]}`); return o(...a) }; return b }
    A.sb = inst.fixture
    script("search_catalog_deals", { player: "Flac", collectionId: "nfl-all-day" })
    await POST(post({}))
    expect(seen).toContain("cached_listings.ilike:player_name=%Flac%")
    expect((toolResult() as { player_identity: { status: string } }).player_identity.status).toBe("none")
  })
  it("get_special_serial_owners asks the board once per label and drops a namesake's rows", async () => {
    const harrisonLabels: PlayerResolution = { ...harrisonOne, player: { ...harrisonOne.player, labels: ["Marvin Harrison"] } }
    const inst = install({
      "rpc:resolve_player_name": { data: harrisonLabels, error: null },
      "rpc:get_special_serial_owners_board": { data: [
        { edition_key: "1:1", player_name: "Marvin Harrison", set_name: "S", tier: "LEGENDARY", serial: 1, circulation_count: 10, tag: "#1", holder_address: "0xa", edition_fmv: 100 },
        { edition_key: "2:2", player_name: "Marvin Harrison Jr.", set_name: "S", tier: "LEGENDARY", serial: 1, circulation_count: 10, tag: "#1", holder_address: "0xb", edition_fmv: 900 },
      ], error: null },
    })
    script("get_special_serial_owners", { playerName: "Marvin Harrison" })
    await POST(post({}))
    const r = toolResult() as { rows?: Array<{ player: string }>; results?: Array<{ player: string }> }
    const rows = (r.rows ?? r.results ?? []) as Array<{ player: string }>
    expect(rows.map((x) => x.player)).toEqual(["Marvin Harrison"])
    expect(inst.rpcCalls.filter((c) => c.name === "get_special_serial_owners_board").map((c) => c.args?.p_player)).toEqual(["Marvin Harrison"])
  })
  it("Pinnacle characters are never sent through the player crosswalk", async () => {
    const inst = install({ "rpc:resolve_player_name": { data: flaccoLabels, error: null } })
    script("search_catalog_deals", { player: "Mickey Mouse", collectionId: "disney-pinnacle" })
    await POST(post({}))
    expect(inst.rpcCalls.map((c) => c.name)).not.toContain("resolve_player_name")
  })
})

describe("get_team_intel resolves a team to its FRANCHISE (batch 61)", () => {
  const raiders = { status: "one", query: "Raiders", franchise: "LV", current_name: "Las Vegas Raiders", primary_name: "Las Vegas Raiders", total_editions: 140,
    names: [{ team_name: "Las Vegas Raiders", editions: 114, current: true }, { team_name: "Oakland Raiders", editions: 18, current: false }, { team_name: "Los Angeles Raiders", editions: 8, current: false }],
    historic_names: [{ team_name: "Oakland Raiders", editions: 18, current: false }, { team_name: "Los Angeles Raiders", editions: 8, current: false }], note: "more than one name" }
  it("'Raiders' is ONE franchise: the roster is read for the primary name and the answer names the historic labels it does not cover", async () => {
    const inst = install({
      "rpc:resolve_team_name": { data: raiders, error: null },
      "rpc:get_team_players": { data: [{ name: "Maxx Crosby", player_slug: "maxx-crosby", is_rookie: false, edition_count: 9, fmv_total_usd: 120 }], error: null },
    })
    script("get_team_intel", { team: "Raiders", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; team: string; franchise: { historic_names: Array<{ team_name: string; editions: number }>; note: string } }
    expect(r).toMatchObject({ status: "ok", team: "Las Vegas Raiders" })
    expect(inst.rpcCalls.find((c) => c.name === "get_team_players")!.args).toMatchObject({ p_team_slug: "las-vegas-raiders" })
    expect(r.franchise.historic_names.map((h) => `${h.team_name}:${h.editions}`)).toEqual(["Oakland Raiders:18", "Los Angeles Raiders:8"])
    expect(r.franchise.note).toMatch(/Oakland Raiders \(18 editions\)/)
  })
  it("two different franchises ('Washington' on Top Shot: the Wizards and the Mystics) are ambiguous — the historic Bullets are NOT a third candidate", async () => {
    install({ "rpc:resolve_team_name": { data: { status: "ambiguous", query: "Washington", franchises: [
      { franchise: "WAS", current_name: "Washington Wizards", primary_name: "Washington Wizards", total_editions: 338, names: [], historic_names: [{ team_name: "Washington Bullets", editions: 16 }] },
      { franchise: "WAS", current_name: "Washington Mystics", primary_name: "Washington Mystics", total_editions: 176, names: [], historic_names: [] },
    ] }, error: null } })
    script("get_team_intel", { team: "Washington" })
    await POST(post({}))
    const r = toolResult() as { status: string; candidates: string[]; franchises: Array<{ historic_names: unknown[] }> }
    expect(r.status).toBe("ambiguous")
    expect(r.candidates).toEqual(["Washington Wizards", "Washington Mystics"])
    expect(r.franchises[0].historic_names).toHaveLength(1)
  })
  it("a FAILED franchise read falls back to the label path and says the franchise map could not be read", async () => {
    install({
      "rpc:resolve_team_name": { data: null, error: { message: "timeout" } },
      editions: { data: [{ team_name: "Portland Trail Blazers" }], error: null },
      "rpc:get_team_players": { data: [{ name: "Damian Lillard", player_slug: "damian-lillard", is_rookie: false, edition_count: 42, fmv_total_usd: 4638 }], error: null },
    })
    script("get_team_intel", { team: "Blazers" })
    await POST(post({}))
    const r = toolResult() as { status: string; franchise: { note: string } }
    expect(r.status).toBe("ok")
    expect(r.franchise.note).toMatch(/could not be read/)
  })
})

describe("resolve_player_name as a tool", () => {
  it("answers 'who is X' with the identity, aliases, relations, namesakes and the player URL", async () => {
    install({ "rpc:resolve_player_name": { data: harrisonOne, error: null } })
    script("resolve_player_name", { playerName: "Marvin Harrison", collectionId: "nfl-all-day" })
    await POST(post({}))
    const r = toolResult() as { status: string; resolved: { identity: { league_player_id: string } }; namesakes: unknown[]; player_url: string; notes: string[] }
    expect(r.status).toBe("one")
    expect(r.resolved.identity.league_player_id).toBe("00-0007024")
    expect(r.namesakes).toHaveLength(1)
    expect(r.player_url).toMatch(/\/nfl-all-day\/player\/marvin-harrison$/)
    expect(r.notes.join(" ")).toMatch(/kinship NOT recorded/)
  })
  it("a failed read is an error, not 'none'; Pinnacle has no crosswalk", async () => {
    install({ "rpc:resolve_player_name": { data: null, error: { message: "timeout" } } })
    script("resolve_player_name", { playerName: "Marvin Harrison", collectionId: "nfl-all-day" })
    await POST(post({}))
    expect(toolResult()).toMatchObject({ status: "error" })
    script("resolve_player_name", { playerName: "Mickey Mouse", collectionId: "disney-pinnacle" })
    await POST(post({}))
    expect((toolResult() as { message: string }).message).toMatch(/characters, not players/)
  })
})

describe("the prompt teaches the model that names are not people", () => {
  const ROUTE = readFileSync(join(ROOT, "app", "api", "support-chat", "route.ts"), "utf8")
  it("names the player_identity block, the never-pool rule, the unavailable state, and the tool", () => {
    expect(ROUTE).toContain("**Names are not people.**")
    expect(ROUTE).toMatch(/NEVER pool two people into one figure/)
    expect(ROUTE).toMatch(/'unavailable' the identity check FAILED/)
    expect(ROUTE).toMatch(/name: "resolve_player_name"/)
    expect(ROUTE).toMatch(/resolve_player_name: 10000/)
  })
})
