import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/search — a typo must not be a dead end (2026-11-06). Measured live:
// "murry", "dontcic", "wemby", "jalen bruson" each returned 0 results because the
// player arm is an exact (accent-folded) substring match. ONLY when the exact
// search finds nothing, the route asks rpc_search_players_fuzzy for the nearest
// player names and re-runs the ordinary search with each — so a fuzzy hit is the
// same row a correctly typed query gets — and labels the answer in meta.fuzzy.

const st = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: any }>, fuzzyFail: false }))
const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const hit = (over: Record<string, unknown>) => ({ kind: "player", label: "x", sublabel: null, slug: "x", collection_id: TS, collection_slug: "nba_top_shot", thumbnail_url: null, edition_count: 3, score: 0.5, ...over })

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      st.calls.push({ fn, args })
      if (fn === "search_accented_labels") return { data: [], error: null }
      if (fn === "franchise_hub_keys") return { data: [], error: null }
      if (fn === "rpc_search_players_fuzzy") {
        if (st.fuzzyFail) return { data: null, error: { message: "boom" } }
        if (args.p_q === "murry") return { data: [{ name: "Jamal Murray", similarity: 0.67 }, { name: "Keegan Murray", similarity: 0.67 }], error: null }
        return { data: [], error: null }
      }
      if (fn === "rpc_search_catalog") {
        if (args.p_q === "Jamal Murray") return { data: [hit({ label: "Jamal Murray", slug: "jamal-murray" }), hit({ kind: "edition", label: "Jamal Murray", slug: "189:6658" })], error: null }
        if (args.p_q === "Keegan Murray") return { data: [hit({ label: "Keegan Murray", slug: "keegan-murray" })], error: null }
        if (args.p_q === "murray") return { data: [hit({ label: "Jamal Murray", slug: "jamal-murray" })], error: null }
        return { data: [], error: null }
      }
      return { data: null, error: null }
    },
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  },
}))

beforeEach(async () => {
  st.calls = []
  st.fuzzyFail = false
  ;(await import("@/lib/search/accented-labels"))._resetAccentedLabelsMemo()
})

const req = (q: string) => ({ nextUrl: new URL("http://localhost/api/search?q=" + encodeURIComponent(q)) }) as any

describe("GET /api/search — closest players for a typo", () => {
  it("'murry' (0 exact) answers with the Murrays' PLAYER rows and says so in meta.fuzzy", async () => {
    const { GET } = await import("@/app/api/search/route")
    const body = await (await GET(req("murry"))).json()
    expect(body.results.map((r: any) => [r.kind, r.label])).toEqual([["player", "Jamal Murray"], ["player", "Keegan Murray"]])
    expect(body.meta.fuzzy).toEqual({ from: "murry", matched: ["Jamal Murray", "Keegan Murray"] })
    // the edition row the re-search also returned is NOT merged — only the named player
    expect(body.results.map((r: any) => r.kind)).not.toContain("edition")
    expect(st.calls.filter((c) => c.fn === "rpc_search_catalog").map((c) => c.args.p_q)).toEqual(["murry", "Jamal Murray", "Keegan Murray"])
  })

  it("a query the exact search serves is never fuzzed, and meta carries no fuzzy key", async () => {
    const { GET } = await import("@/app/api/search/route")
    const body = await (await GET(req("murray"))).json()
    expect(body.results).toHaveLength(1)
    expect("fuzzy" in body.meta).toBe(false)
    expect(st.calls.some((c) => c.fn === "rpc_search_players_fuzzy")).toBe(false)
  })

  it("a failed fuzzy read leaves the honest empty answer, unlabelled", async () => {
    const { GET } = await import("@/app/api/search/route")
    st.fuzzyFail = true
    const res = await GET(req("murry"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([])
    expect("fuzzy" in body.meta).toBe(false)
  })

  it("nothing close → the plain empty answer", async () => {
    const { GET } = await import("@/app/api/search/route")
    const body = await (await GET(req("zzzzqqq"))).json()
    expect(body.results).toEqual([])
    expect("fuzzy" in body.meta).toBe(false)
  })

  it("a 3-character query is not fuzzed (too short to mean anything)", async () => {
    const { fuzzyPlayerNames } = await import("@/lib/search/fuzzy-players")
    const calls: string[] = []
    const names = await fuzzyPlayerNames({ rpc: async (fn) => { calls.push(fn); return { data: [], error: null } } }, "mur", null)
    expect(names).toEqual([])
    expect(calls).toEqual([])
  })
})
