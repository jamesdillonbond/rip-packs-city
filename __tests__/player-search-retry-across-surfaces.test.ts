import { describe, it, expect, beforeEach, vi } from "vitest"

// #207 platform-wide (2026-10-22): every surface whose player search reaches the
// database as an accent-sensitive ilike retries an EMPTY answer once with the
// resolver's single spelling, and reports it (meta.player_resolved). Driven here
// against a fake PostgREST whose ilike behaves like Postgres's: case-blind,
// accent-SENSITIVE. A search that matched is never retried.

type Row = Record<string, unknown>
const st = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  verdict: (_args: { p_collection_id: string; p_name: string }): unknown => ({ status: "none", query: "" }),
  rpcCalls: [] as string[],
  ilikes: [] as Array<[string, string]>,
}))

function likeToRe(pattern: string): RegExp {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\") { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue }
    re += c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`, "is")
}

function builder(table: string) {
  const ilikes: Array<[string, string]> = []
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const rows = table === "pipeline_runs" ? [] : st.rows.filter((r) => ilikes.every(([c, p]) => likeToRe(p).test(String(r[c] ?? ""))))
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej)
      }
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: null, error: null })
      return (...args: unknown[]) => {
        if (prop === "ilike") { ilikes.push([String(args[0]), String(args[1])]); st.ilikes.push([String(args[0]), String(args[1])]) }
        return b
      }
    },
  })
  return b
}

const fake = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: any) => {
    st.rpcCalls.push(fn)
    return fn === "resolve_player_name" ? { data: st.verdict(args), error: null } : { data: null, error: null }
  },
}
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: fake, supabase: fake }))

const one = (name: string) => ({ status: "one", query: "q", query_slug: "q", matched_via: "slug", namesakes: [], player: { id: "p", name, slug: "s", team: null, edition_count: 1, labels: [name] }, aliases: [], identity: null, relations: [], matched_query_as: "q" })
const req = (path: string) => new Request(`https://t${path}`) as any

beforeEach(() => {
  st.rows = []
  st.verdict = () => ({ status: "none", query: "" })
  st.rpcCalls = []
  st.ilikes = []
})

describe("public insight boards retry an accent-only player miss", () => {
  const cases: Array<[string, string, () => Promise<any>, (b: any) => Row[]]> = [
    ["deals", "/api/public/insights/deals?player=doncic", async () => (await import("@/app/api/public/insights/deals/route")).GET, (b) => b.rows],
    ["first-mint", "/api/public/insights/first-mint?player=doncic", async () => (await import("@/app/api/public/insights/first-mint/route")).GET, (b) => b.trophies],
    ["squeeze", "/api/public/insights/squeeze?player=doncic", async () => (await import("@/app/api/public/insights/squeeze/route")).GET, (b) => b.rows],
    ["offer-spread", "/api/public/insights/offer-spread?player=doncic", async () => (await import("@/app/api/public/insights/offer-spread/route")).GET, (b) => b.rows],
    ["candy-mlb", "/api/public/insights/candy-mlb?player=doncic", async () => (await import("@/app/api/public/insights/candy-mlb/route")).GET, (b) => b.rows],
    ["panini-squeeze", "/api/public/insights/panini-squeeze?player=doncic", async () => (await import("@/app/api/public/insights/panini-squeeze/route")).GET, (b) => b.rows],
  ]
  for (const [name, path, load, rowsOf] of cases) {
    it(`${name}: "doncic" → Luka Dončić, reported`, async () => {
      st.rows = [{ player_name: "Luka Dončić", set_name: "Base", fmv_usd: 10, squeeze_pct: 90, low_ask: 20, discount_pct: 30, multiplier: 5 }]
      st.verdict = () => one("Luka Dončić")
      const GET = await load()
      const res = await GET(req(path))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(rowsOf(body).map((r) => r.player_name)).toEqual(["Luka Dončić"])
      expect(body.meta.player_resolved).toEqual({ from: "doncic", to: "Luka Dončić" })
    })
    it(`${name}: a search that matched is untouched — no resolver read`, async () => {
      st.rows = [{ player_name: "Luka Dončić", set_name: "Base", fmv_usd: 10, squeeze_pct: 90, low_ask: 20, discount_pct: 30, multiplier: 5 }]
      st.verdict = () => one("Luka Dončić")
      const GET = await load()
      const body = await (await GET(req(path.replace("doncic", "Don%C4%8Di%C4%87")))).json()
      expect(rowsOf(body)).toHaveLength(1)
      expect(body.meta.player_resolved).toBeUndefined()
      expect(st.rpcCalls).not.toContain("resolve_player_name")
    })
  }
})

describe("deal alerts store the catalog spelling of a typed player name", () => {
  it("canonicalPlayerNames turns 'luka doncic' into the resolver's spelling and reports it; unknown names stay", async () => {
    const { canonicalPlayerNames } = await import("@/lib/search/player-search-retry")
    st.verdict = (a) => (a.p_name === "luka doncic" ? one("Luka Dončić") : { status: "none", query: a.p_name })
    const out = await canonicalPlayerNames(fake, ["luka doncic", "Nobody Atall"], ["95f28a17-224a-4025-96ad-adf8a4c63bfd"])
    expect(out.names).toEqual(["Luka Dončić", "Nobody Atall"])
    expect(out.resolved).toEqual([{ from: "luka doncic", to: "Luka Dončić" }])
  })

  // 2026-10-27: a collection that already spells the name as typed abstained, so ONE other collection's spelling
  // replaced it and the alert stopped matching in the first collection.
  it("keeps the typed spelling when any collection in scope already names it that way", async () => {
    const { canonicalPlayerNames } = await import("@/lib/search/player-search-retry")
    const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd", PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
    st.verdict = (a) => (a.p_collection_id === TS ? one("KJ Martin") : one("Kenyon Martin Jr."))
    const out = await canonicalPlayerNames(fake, ["Kenyon Martin Jr."], [TS, PANINI])
    expect(out.names).toEqual(["Kenyon Martin Jr."])
    expect(out.resolved).toEqual([])
  })
})

describe("the alerts player typeahead", () => {
  it("leads with the resolver's name for an unaccented query, and also matches a later word's start", async () => {
    st.rows = [{ player_name: "Nikola Jokić" }]
    st.verdict = (a) => (a.p_collection_id === "95f28a17-224a-4025-96ad-adf8a4c63bfd" ? one("Nikola Jokić") : { status: "none", query: "" })
    const { GET } = await import("@/app/api/alerts/suggest/route")
    const body = await (await GET(req("/api/alerts/suggest?kind=player&q=jokic&collection=95f28a17-224a-4025-96ad-adf8a4c63bfd"))).json()
    expect(body.suggestions).toEqual(["Nikola Jokić"])
    const word = await (await GET(req("/api/alerts/suggest?kind=set&q=bas"))).json()
    expect(st.ilikes.map(([, p]) => p)).toContain("% bas%")
    expect(word.suggestions).toEqual([])
  })
})

describe("edition search (alert-create modal)", () => {
  it("'doncic' → Luka Dončić editions, reported; an exact spelling is untouched", async () => {
    st.rows = [{ id: "e1", external_id: "1:2", player_name: "Luka Dončić", set_name: "Base", tier: "COMMON", collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd" }]
    st.verdict = (a) => (a.p_collection_id === "95f28a17-224a-4025-96ad-adf8a4c63bfd" ? one("Luka Dončić") : { status: "none", query: "" })
    const { GET } = await import("@/app/api/edition-search/route")
    const r = (q: string) => ({ nextUrl: new URL(`https://t/api/edition-search?q=${encodeURIComponent(q)}`) }) as any
    const body = await (await GET(r("doncic"))).json()
    expect(body.results.map((x: Row) => x.player_name)).toEqual(["Luka Dončić"])
    expect(body.player_resolved).toEqual({ from: "doncic", to: "Luka Dončić" })
    st.rpcCalls = []
    const exact = await (await GET(r("Luka Dončić"))).json()
    expect(exact.player_resolved).toBeUndefined()
    expect(st.rpcCalls).not.toContain("resolve_player_name")
  })
})
