import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

/**
 * /api/collection-moments?collection=candy-mlb&property=<slug> (2026-11-26) — the Candy Binder's league /
 * brand filter.
 * - the page comes from get_candy_wallet_cards_for_property, not the shared RPC;
 * - an unknown slug, or any slug on another collection, is a 400 — never the whole Binder under a brand;
 * - a failed lookup is a 503; without the parameter nothing changes.
 */

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/collection-moments/route"

const WALLET = "6uKecEEDfWyWY6HLkPJ2kpKUgq8HekLRjtuTatoPqCaW"
const req = (q: string) => ({ nextUrl: new URL(`https://t/api/collection-moments?wallet=${WALLET}&${q}`) }) as never
const card = (id: string, set: string) => ({ moment_id: id, edition_key: id, serial_number: 3, player_name: null, set_name: set, tier: "RARE", fmv_usd: 10, confidence: "MEDIUM" })
const calls: Array<[string, Record<string, unknown> | undefined]> = []

function install(f: Record<string, unknown>) {
  const sb = makeSupabaseFixture({
    "rpc:get_wallet_total_fmv": { data: 10, error: null },
    "rpc:get_acquisition_stats": { data: null, error: null },
    ...f,
  } as never) as { rpc: (n: string, a?: Record<string, unknown>) => unknown }
  const rpc = sb.rpc.bind(sb)
  sb.rpc = (n, a) => { calls.push([n, a]); return rpc(n, a) }
  state.sb = sb
}

beforeEach(() => { state.sb = null; calls.length = 0 })

describe("Candy Binder — league / brand filter", () => {
  it("reads the brand's own page, passing the wallet untouched and the other filters through", async () => {
    install({
      publisher_properties: { data: [{ slug: "dc" }], error: null },
      "rpc:get_candy_wallet_cards_for_property": { data: { moments: [card("batman-1", "Batman (1940-2011) #1")], total_count: 16856 }, error: null },
      "rpc:get_wallet_moments_with_fmv": { data: { moments: [card("aaron-judge", "2026 MLB Base Series ICONs")], total_count: 125407 }, error: null },
    })
    const res = await GET(req("collection=candy-mlb&property=dc&tier=RARE&sortBy=serial_asc&page=2&limit=50"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments.map((m: { setName?: string; set_name?: string }) => m.setName ?? m.set_name)).toEqual(["Batman (1940-2011) #1"])
    const page = calls.find((c) => c[0] === "get_candy_wallet_cards_for_property")!
    expect(page[1]).toEqual({ p_wallet: WALLET, p_property: "dc", p_sort_by: "serial_asc", p_limit: 50, p_offset: 50, p_player: null, p_tier: "RARE" })
    expect(calls.some((c) => c[0] === "get_wallet_moments_with_fmv")).toBe(false)
  })
  it("an unknown or malformed brand is a 400 before any page read", async () => {
    install({ publisher_properties: { data: [], error: null } })
    for (const q of ["collection=candy-mlb&property=nba", "collection=candy-mlb&property=" + encodeURIComponent("dc;x")]) {
      const res = await GET(req(q))
      expect(res.status, q).toBe(400)
      expect((await res.json()).error, q).toBe("unknown_league")
    }
    expect(calls.some((c) => c[0].startsWith("get_"))).toBe(false)
  })
  it("a failed brand lookup is a 503, never an unfiltered Binder", async () => {
    install({ publisher_properties: { data: null, error: { message: "boom", code: "57014" } }, "rpc:get_wallet_moments_with_fmv": { data: { moments: [card("a", "S")], total_count: 1 }, error: null } })
    const res = await GET(req("collection=candy-mlb&property=dc"))
    expect(res.status).toBe(503)
    expect((await res.json()).moments).toBeUndefined()
    expect(calls.some((c) => c[0] === "get_wallet_moments_with_fmv")).toBe(false)
  })
  it("without the parameter the shared read is used as before", async () => {
    install({ "rpc:get_wallet_moments_with_fmv": { data: { moments: [card("aaron-judge", "2026 MLB Base Series ICONs")], total_count: 1 }, error: null } })
    const res = await GET(req("collection=candy-mlb"))
    expect(res.status).toBe(200)
    expect(calls.some((c) => c[0] === "get_candy_wallet_cards_for_property")).toBe(false)
    expect(calls.some((c) => c[0] === "get_wallet_moments_with_fmv")).toBe(true)
  })
})
