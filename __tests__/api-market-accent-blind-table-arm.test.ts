import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/market — #207 on a TABLE arm (Pinnacle; Candy and Panini share the
// wrapper). The arm's PostgREST ilike is accent-sensitive; an EMPTY player search
// is retried with an accent-tolerant pattern and the rows are re-checked exactly.
// The mock below applies the ilike the route sends, with Postgres semantics.

type Row = Record<string, any>
const st: { rows: Row[]; ilikes: string[]; verdict: unknown; rpcs: string[] } = { rows: [], ilikes: [], verdict: { status: "none", query: "" }, rpcs: [] }

function ilike(value: string, pattern: string): boolean {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "\\" && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue }
    re += c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`, "is").test(value)
}

vi.mock("@/lib/supabase", () => {
  const make = () => {
    let pat: string | null = null
    const b: any = {
      select: () => b, not: () => b, gt: () => b, gte: () => b, lte: () => b, eq: () => b, in: () => b,
      order: () => b, limit: () => b, range: () => b,
      ilike: (col: string, v: string) => { if (col === "character_name") { pat = v; st.ilikes.push(v) } return b },
      then: (resolve: any) => {
        const data = pat === null ? st.rows : st.rows.filter((r) => ilike(String(r.character_name), pat!))
        return resolve({ data, error: null, count: data.length })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: () => make(), rpc: async (fn: string) => { st.rpcs.push(fn); return { data: fn === "resolve_player_name" ? st.verdict : null, error: null } } } }
})

const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const cat = (render_id: string, character_name: string): Row => ({
  render_id, set_name: "Base", character_name, series_name: "2023", variant: "Standard", total_minted: 100,
  floor_ask: 10, fmv_usd: 9, fmv_confidence: "MEDIUM", thumbnail_url: null, floor_ask_updated_at: new Date().toISOString(),
})
const req = (qs: string) => ({ nextUrl: new URL(`https://t/api/market?collectionId=${PINNACLE}&${qs}`) }) as any

beforeEach(() => { st.rows = []; st.ilikes = []; st.verdict = { status: "none", query: "" }; st.rpcs = [] })

describe("/api/market Pinnacle — accent-blind Player fallback (#207)", () => {
  it("an unaccented search that matched nothing finds the accented name, and only it", async () => {
    const { GET } = await import("@/app/api/market/route")
    st.rows = [cat("A", "Mérida"), cat("B", "Mirabel Madrigal"), cat("C", "Moana")]
    const body = await (await GET(req("player=merida"))).json()
    expect(st.ilikes[0]).toBe("%merida%")
    expect(st.ilikes.length).toBe(2)
    const names = body.listings.map((l: any) => l.player_name ?? l.playerName)
    expect(names).toEqual(["Mérida"])
  })

  it("a search that matched as typed runs once and is untouched", async () => {
    const { GET } = await import("@/app/api/market/route")
    st.rows = [cat("A", "Mérida"), cat("C", "Moana")]
    const body = await (await GET(req("player=moana"))).json()
    expect(st.ilikes).toEqual(["%moana%"])
    expect(body.listings.map((l: any) => l.player_name ?? l.playerName)).toEqual(["Moana"])
  })

  // 2026-10-23: the in-arm widened pattern cannot be formed for a short name whose
  // every letter can carry an accent ("agustin", "acuna" — live, Candy "acuna"
  // answered 0 listings while "Acuña" answered 5). The route then resolves the
  // name (resolve_player_name) and REPORTS the swap.
  it("a short name the widened pattern cannot express is resolved, retried and reported", async () => {
    const { GET } = await import("@/app/api/market/route")
    st.rows = [cat("A", "Agustín"), cat("C", "Moana")]
    st.verdict = { status: "one", query: "agustin", query_slug: "agustin", matched_via: "slug", namesakes: [], player: { id: "p", name: "Agustín", slug: "agustin", team: null, edition_count: 1, labels: ["Agustín"] }, aliases: [], identity: null, relations: [], matched_query_as: "agustin" }
    const body = await (await GET(req("player=agustin"))).json()
    expect(st.rpcs).toContain("resolve_player_name")
    expect(body.listings.map((l: any) => l.player_name ?? l.playerName)).toEqual(["Agustín"])
    expect(body.playerResolved).toEqual({ from: "agustin", to: "Agustín" })
  })

  it("a true empty stays empty and unlabelled when the resolver names no one", async () => {
    const { GET } = await import("@/app/api/market/route")
    st.rows = [cat("C", "Moana")]
    const body = await (await GET(req("player=zzzz"))).json()
    expect(body.listings).toEqual([])
    expect(body.playerResolved).toBeUndefined()
  })
})
