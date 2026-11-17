import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/search — #207 for the TEAM and SET arms (2026-10-23). rpc_search_catalog
// folds accents in its player arm only; measured, none of the 12 accented team /
// set labels was reachable without its accent ("atletico", "clasico", "idolos").
// The route now re-runs an accent-only match with the exact label and leads with
// its team / set row. A query the raw search already serves is not re-run.

const st = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: any }>, labelsFail: false }))

const hit = (over: Record<string, unknown>) => ({ kind: "player", label: "x", sublabel: null, slug: "x", collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75", collection_slug: "laliga_golazos", thumbnail_url: null, edition_count: 3, score: 0.5, ...over })

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      st.calls.push({ fn, args })
      if (fn === "search_accented_labels") {
        return st.labelsFail ? { data: null, error: { message: "boom" } } : { data: [
          { kind: "team", label: "Atlético de Madrid" }, { kind: "set", label: "ElClásico" }, { kind: "team", label: "Málaga CF" },
        ], error: null }
      }
      if (fn === "franchise_hub_keys") return { data: [], error: null }
      if (fn === "rpc_search_catalog") {
        if (args.p_q === "Atlético de Madrid") return { data: [hit({ kind: "team", label: "Atlético de Madrid", slug: "atl-tico-de-madrid" }), hit({ kind: "player", label: "Koke" })], error: null }
        if (args.p_q === "ElClásico") return { data: [hit({ kind: "set", label: "ElClásico", slug: "elcl-sico" })], error: null }
        if (args.p_q === "atletico") return { data: [hit({ kind: "player", label: "Atletico de Madrid", slug: "atletico-de-madrid", collection_id: "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b", collection_slug: "panini_blockchain" })], error: null }
        return { data: [], error: null }
      }
      return { data: null, error: null }
    },
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  },
}))

beforeEach(async () => {
  st.calls = []
  st.labelsFail = false
  ;(await import("@/lib/search/accented-labels"))._resetAccentedLabelsMemo()
})

const req = (q: string) => ({ nextUrl: new URL("http://localhost/api/search?q=" + encodeURIComponent(q)) }) as any

describe("accentOnlyLabelMatches", () => {
  it("matches a label only when the accent is what the raw search would miss", async () => {
    const { accentOnlyLabelMatches } = await import("@/lib/search/accented-labels")
    const labels = [{ kind: "team", label: "Atlético de Madrid" }, { kind: "set", label: "ElClásico" }]
    expect(accentOnlyLabelMatches("atletico", labels).map((l) => l.label)).toEqual(["Atlético de Madrid"])
    expect(accentOnlyLabelMatches("atletico madrid", labels).map((l) => l.label)).toEqual(["Atlético de Madrid"])
    expect(accentOnlyLabelMatches("clasico", labels).map((l) => l.label)).toEqual(["ElClásico"])
    // the raw ILIKE already finds these — never re-run
    expect(accentOnlyLabelMatches("madrid", labels)).toEqual([])
    expect(accentOnlyLabelMatches("Atlético", labels)).toEqual([])
    expect(accentOnlyLabelMatches("lakers", labels)).toEqual([])
  })
})

describe("GET /api/search — accented team / set labels", () => {
  it("'atletico' leads with the Atlético de Madrid TEAM row, then the ordinary hits", async () => {
    const { GET } = await import("@/app/api/search/route")
    const body = await (await GET(req("atletico"))).json()
    expect(body.results[0]).toMatchObject({ kind: "team", label: "Atlético de Madrid" })
    expect(body.results.map((r: any) => r.label)).not.toContain("Koke") // only the label's own kind is merged
    expect(st.calls.filter((c) => c.fn === "rpc_search_catalog").map((c) => c.args.p_q)).toEqual(["atletico", "Atlético de Madrid"])
  })

  it("'clasico' finds the ElClásico SET", async () => {
    const { GET } = await import("@/app/api/search/route")
    const body = await (await GET(req("clasico"))).json()
    expect(body.results.map((r: any) => [r.kind, r.label])).toEqual([["set", "ElClásico"]])
  })

  it("a query the raw search serves is not re-run; a failed label read adds nothing", async () => {
    const { GET } = await import("@/app/api/search/route")
    await GET(req("madrid"))
    expect(st.calls.filter((c) => c.fn === "rpc_search_catalog")).toHaveLength(1)
    st.calls = []
    st.labelsFail = true
    ;(await import("@/lib/search/accented-labels"))._resetAccentedLabelsMemo()
    const body = await (await GET(req("atletico"))).json()
    expect(body.results.map((r: any) => r.kind)).not.toContain("team")
    expect(st.calls.filter((c) => c.fn === "rpc_search_catalog")).toHaveLength(1)
  })
})
