import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — known-issues #207 (2026-10-21). Every arm matched the Player
// box with an accent-SENSITIVE ilike, so "vinicius" found no listing for
// "Vinícius Júnior" and the page read as an empty market for a player with live
// asks. An EMPTY player search on a catalog arm is now retried with the single
// catalog name it matches accent-blind, and the response SAYS so (playerResolved);
// a search that matched anything is untouched.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

// The catalog read is memoized per module instance (an hour), so every test
// imports a FRESH route module.
async function route() {
  vi.resetModules()
  return (await import("@/app/api/market/route")).GET
}

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const req = (qs: string) => ({ nextUrl: new URL(`https://t/api/market?collectionId=${GOLAZOS}&${qs}`) }) as never

const ROW = {
  edition_id: "g1", external_id: "gz-vini-1", player_name: "Vinícius Júnior", team_name: "Real Madrid",
  set_name: "Base", series_name: "1", tier: "COMMON", circulation_count: 5000, floor_ask: 3.5,
  listed_count: 9, fmv_usd: 4, discount_pct: 12, confidence: "LOW", thumbnail_url: null, badges: null,
  last_listed_at: "2026-10-01T00:00:00Z",
}

// The arm behaves like the real RPC: player_name ILIKE '%' || p_player || '%'.
const ilike = (name: string, p: string) => name.toLowerCase().includes(p.toLowerCase())

let calls: Array<{ name: string; args: Record<string, unknown> }>
function install(players: string[] | "fail") {
  const fx = makeSupabaseFixture({ editions: { data: [], error: null } } as never) as any
  calls = []
  const base = fx.rpc.bind(fx)
  fx.rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    if (name === "get_golazos_market_editions_v2") {
      const p = String(args.p_player ?? "")
      return { data: !p || ilike(ROW.player_name, p) ? [ROW] : [], error: null }
    }
    if (name === "get_market_filter_options") {
      return players === "fail"
        ? { data: null, error: { message: "statement timeout" } }
        : { data: { sets: [], series: [], teams: [], players }, error: null }
    }
    return base(name, args)
  }
  state.sb = fx
}

const armCalls = () => calls.filter((c) => c.name === "get_golazos_market_editions_v2").map((c) => c.args.p_player)

beforeEach(() => { state.sb = null })

describe("GET /api/market — accent-blind Player search (#207)", () => {
  it("an unaccented name with no match as typed is retried with the catalog spelling, and says so", async () => {
    install(["Vinícius Júnior", "Jude Bellingham"])
    const GET = await route()
    const body = await (await GET(req("player=vinicius"))).json()
    expect(armCalls()).toEqual(["vinicius", "Vinícius Júnior"])
    expect(body.playerResolved).toEqual({ from: "vinicius", to: "Vinícius Júnior" })
    expect(body.listings.length).toBe(1)
  })

  it("a search that matched as typed is untouched — no catalog read, no retry, no note", async () => {
    install(["Vinícius Júnior"])
    const GET = await route()
    const body = await (await GET(req("player=J%C3%BAnior"))).json()
    expect(armCalls()).toEqual(["Júnior"])
    expect(calls.some((c) => c.name === "get_market_filter_options")).toBe(false)
    expect(body.playerResolved).toBeUndefined()
  })

  it("ambiguous (two accent-only candidates) is not guessed: the empty answer stands", async () => {
    install(["Vinícius Júnior", "Vinícius Tobias"])
    const GET = await route()
    const body = await (await GET(req("player=vinicius"))).json()
    expect(armCalls()).toEqual(["vinicius"])
    expect(body.playerResolved).toBeUndefined()
    expect(body.listings).toEqual([])
  })

  it("a failed catalog read resolves nothing — the empty answer stands, not a 500", async () => {
    install("fail")
    const GET = await route()
    const res = await GET(req("player=vinicius"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
    expect(body.playerResolved).toBeUndefined()
  })

  it("a name the typed text matches AS TYPED is never swapped for an accented one", async () => {
    // "Luka" matches "Luka Garza" as typed, so an empty Luka search is a true empty.
    install(["Luka Garza", "Luka Dončić"])
    const GET = await route()
    const body = await (await GET(req("player=luka"))).json()
    expect(body.playerResolved).toBeUndefined()
    expect(armCalls()).toEqual(["luka"])
  })
})
