import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/market-cap. Runs the REAL
// fetchMarketCapBoard against a stubbed service-role client so the RPC arguments
// the route sends are what is asserted — including the refusals: an unknown
// collection or group must 400 WITHOUT reaching the database (SUBSTITUTION: a
// misspelled collection answered with another collection's numbers is the failure
// where nothing fails).

const state: { calls: Array<{ fn: string; args: any }>; data: any; error: any } = { calls: [], data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.calls.push({ fn, args })
      return { data: state.error ? null : state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/public/insights/market-cap/route"

const req = (qs = "") => {
  const url = new URL(`https://t/api/public/insights/market-cap${qs}`)
  return { url: url.toString(), nextUrl: url } as any
}

const ROW = {
  collection_slug: "laliga_golazos", group_key: "laliga_golazos", group_label: "laliga_golazos",
  set_name: null, tier: null, series_num: null, series_name: null, edition_external_id: null,
  editions: 575, editions_supply_known: 0, editions_priced: 499,
  minted: "1919761", burned: null, issuer_held: null, collector_held: null,
  mcap_usd: null, mcap_high_conf_usd: null, mcap_minted_usd: "8914393.23",
}

beforeEach(() => {
  state.calls = []
  state.data = []
  state.error = null
})

describe("GET /api/public/insights/market-cap", () => {
  it("defaults an ABSENT group to collection and an absent collection to all", async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(state.calls).toEqual([{ fn: "get_market_cap_board", args: { p_group: "collection", p_collection: null, p_limit: 100 } }])
    const body = await res.json()
    expect(body.meta.source).toBe("get_market_cap_board")
    expect(typeof body.meta.method_note).toBe("string")
  })

  it("resolves a URL slug to the DB slug the RPC keys on", async () => {
    await GET(req("?group=player&collection=nfl-all-day"))
    expect(state.calls[0].args).toMatchObject({ p_group: "player", p_collection: "nfl_all_day" })
  })

  it("accepts the DB slug too, and the ufc alias", async () => {
    await GET(req("?collection=nba_top_shot"))
    await GET(req("?collection=ufc-strike"))
    expect(state.calls.map((c) => c.args.p_collection)).toEqual(["nba_top_shot", "ufc_strike"])
  })

  it("REFUSES an unknown collection with 400 and never queries — no other collection's numbers", async () => {
    const res = await GET(req("?group=player&collection=candy_mlbx"))
    expect(res.status).toBe(400)
    expect(state.calls).toHaveLength(0)
    const body = await res.json()
    expect(body.rows).toBeUndefined()
    expect(JSON.stringify(body)).not.toMatch(/nba_top_shot|Top Shot/)
  })

  it("REFUSES an unknown group with 400 and never queries", async () => {
    const res = await GET(req("?group=wallet"))
    expect(res.status).toBe(400)
    expect(state.calls).toHaveLength(0)
  })

  it("clamps limit to 1..500, and a non-numeric or zero limit falls back to the default", async () => {
    await GET(req("?limit=99999"))
    await GET(req("?limit=-4"))
    await GET(req("?limit=abc"))
    await GET(req("?limit=0"))
    expect(state.calls.map((c) => c.args.p_limit)).toEqual([500, 1, 100, 100])
  })

  it("keeps an UNKNOWN cap null end to end — never a $0", async () => {
    state.data = [ROW]
    const res = await GET(req())
    const body = await res.json()
    expect(body.rows[0].mcap_usd).toBeNull()
    expect(body.rows[0].collector_held).toBeNull()
    expect(body.rows[0].burned).toBeNull()
    expect(body.rows[0].mcap_minted_usd).toBe(8914393.23)
    expect(body.rows[0].minted).toBe(1919761)
  })

  it("500s without leaking driver text when the RPC errors", async () => {
    state.error = { message: "relation badge_editions does not exist" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain("badge_editions")
    expect(body.rows).toBeUndefined()
  })
})
