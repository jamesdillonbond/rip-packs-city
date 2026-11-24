import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NextRequest } from "next/server"

// 2026-11-23 evening, Candy parity pass 1: Candy serial-premiums + listed-share squeeze boards (the boards Disney
// Pinnacle got that afternoon). Pins: a failed read is never an empty board; an unknown premium is "—" (never 1.0×);
// the jersey band is its own band (not folded into #1); a squeeze row's "0 listed" carries the sweep's time; edition
// links go to /candy-mlb/edition/<external_id>, URL-encoded (Candy keys carry ':').

let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let lastRpc: { fn: string; args: unknown } | null = null
vi.mock("@/lib/supabase", () => {
  const admin = {
    rpc: async (fn: string, args: unknown) => { lastRpc = { fn, args }; return rpcResult },
    from: () => { throw new Error("no table reads") },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { shapeCandySerialPremiums, shapeCandySqueeze, CANDY_SERIAL_BAND_LABEL } from "@/lib/insights/candy-parity-boards"
import { GET as serialGET } from "@/app/api/public/insights/candy-serial-premiums/route"
import { GET as squeezeGET } from "@/app/api/public/insights/candy-squeeze/route"
import SerialPage from "@/app/insights/candy-serial-premiums/page"
import SqueezePage from "@/app/insights/candy-squeeze/page"
import { getInsightsBoard } from "@/lib/insights/board-registry"

const serialRow = {
  external_id: "asg26:jhoan-duran-core", name: "Jhoan Duran", set_name: "2026 MLB All-Star Game ICONs", tier: "COMMON",
  circulation_count: 225, serial_number: 1, band: "first", price_usd: 23.26, sold_at: "2026-11-23T20:18:43Z",
  n_comps: 6, comp_median_usd: 0.42, multiplier: 55.38,
}
const jerseyRow = { ...serialRow, external_id: "aaron-judge", name: "Aaron Judge", serial_number: 99, band: "jersey", n_comps: 2, comp_median_usd: null, multiplier: null }
const squeezeRow = {
  external_id: "shohei-ohtani", player_name: "Shohei Ohtani", set_name: "2026 MLB Base Series ICONs", rarity_label: "Core",
  thumbnail_url: null, minted: 250, burned: null, issuer_held: 11, collector_held: 239, listed: 0, pct_listed: 0,
  floor_ask_usd: null, fmv_usd: 16.16, sales_30d: 4,
}

beforeEach(() => { rpcResult = { data: null, error: null }; lastRpc = null })

describe("shapes", () => {
  it("keep NULLs null, keep the jersey band, refuse a non-payload", () => {
    const p = shapeCandySerialPremiums({ stats: [{ band: "jersey", sales: 100, with_comps: 70, median_multiplier: 2.89 }], rows: [jerseyRow] })
    expect(p.rows[0].band).toBe("jersey")
    expect(p.stats[0].band).toBe("jersey")
    expect(p.rows[0].multiplier).toBeNull()
    expect(CANDY_SERIAL_BAND_LABEL.jersey).toBe("jersey match")
    expect(() => shapeCandySerialPremiums(null)).toThrow()
    expect(() => shapeCandySqueeze({ nope: 1 })).toThrow()
    const sq = shapeCandySqueeze({ rows: [squeezeRow] })
    expect(sq.rows[0].floor_ask_usd).toBeNull()
    // The census sees holders, not burns: an unknown burn stays null, never 0.
    expect(sq.rows[0].burned).toBeNull()
    expect(sq.sets).toEqual([])
  })
})

describe("routes", () => {
  it("serial premiums: rows on success, 5xx (never an empty board) on failure", async () => {
    rpcResult = { data: { stats: [], rows: [serialRow] }, error: null }
    const ok = await serialGET()
    expect(ok.status).toBe(200)
    expect(lastRpc?.fn).toBe("get_candy_serial_premiums")
    expect((await ok.json()).rows).toHaveLength(1)
    rpcResult = { data: null, error: { message: "down" } }
    const bad = await serialGET()
    expect(bad.status).toBeGreaterThanOrEqual(500)
    expect((await bad.json()).rows).toBeUndefined()
  })
  it("squeeze: passes the filters, 400s a malformed one, 5xx on failure", async () => {
    rpcResult = { data: { listings_seen_at: "2026-11-24T00:35:26Z", min_held: 50, editions_ranked: 1, editions_zero_listed: 1, rows: [squeezeRow] }, error: null }
    const ok = await squeezeGET(new NextRequest("https://t/api/public/insights/candy-squeeze?min_held=50&limit=10"))
    expect(ok.status).toBe(200)
    expect(lastRpc).toEqual({ fn: "get_candy_listed_squeeze", args: { p_min_held: 50, p_limit: 10 } })
    const body = await ok.json()
    expect(body.meta.listings_seen_at).toBe("2026-11-24T00:35:26Z")
    expect(body.meta.editions_zero_listed).toBe(1)
    const bad = await squeezeGET(new NextRequest("https://t/api/public/insights/candy-squeeze?limit=0"))
    expect(bad.status).toBe(400)
    rpcResult = { data: null, error: { message: "down" } }
    const down = await squeezeGET(new NextRequest("https://t/api/public/insights/candy-squeeze"))
    expect(down.status).toBeGreaterThanOrEqual(500)
  })
})

describe("pages", () => {
  it("serial premiums renders all three bands; no comparables reads '—' and 'too few'; links are encoded", async () => {
    rpcResult = {
      data: {
        stats: [
          { band: "first", sales: 147, with_comps: 86, median_multiplier: 7.33 },
          { band: "jersey", sales: 100, with_comps: 70, median_multiplier: 2.89 },
          { band: "perfect", sales: 114, with_comps: 73, median_multiplier: 1.65 },
        ],
        rows: [serialRow, jerseyRow],
      },
      error: null,
    }
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).toContain("Jersey-match serials")
    expect(html).toContain("2.89×")
    expect(html).toContain("55.4×")
    expect(html).toContain("too few")
    expect(html).toContain("jersey match")
    expect(html).toContain('href="/candy-mlb/edition/asg26%3Ajhoan-duran-core"')
    expect(html).not.toContain("1.00×")
  })
  it("serial premiums on a failed read does not say 'no sale on record'", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).not.toContain("on record yet")
  })
  it("squeeze dates the sweep, says 'none listed' (never $0), names each set and Candy's own rarity", async () => {
    const asg = { ...squeezeRow, external_id: "asg26:matt-olson-rare", player_name: "Matt Olson", set_name: "2026 MLB All-Star Game ICONs", rarity_label: "Rare", listed: 5, pct_listed: 12.8, floor_ask_usd: 3.45 }
    rpcResult = {
      data: {
        listings_seen_at: "2026-11-24T00:35:26Z", min_held: 25, editions_ranked: 2, editions_zero_listed: 1,
        sets: [{ set_name: "2026 MLB All-Star Game ICONs", ranked: 1, zero_listed: 0 }, { set_name: "2026 MLB Base Series ICONs", ranked: 1, zero_listed: 1 }],
        rows: [squeezeRow, asg],
      },
      error: null,
    }
    const html = renderToStaticMarkup(await SqueezePage())
    expect(html).toContain("2026 MLB All-Star Game ICONs: 1 ranked, 0 unlisted")
    expect(html).toContain("Rare · 2026 MLB All-Star Game ICONs")
    expect(html).toContain('href="/candy-mlb/edition/asg26%3Amatt-olson-rare"')
    expect(html).not.toContain("COMMON")
    expect(html).toContain("Listings as of Nov 23")
    expect(html).toContain("none listed")
    expect(html).toContain("Candy-held")
    expect(html).not.toContain("$0.00")
  })
  it("squeeze on a failed read claims nothing about supply", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = renderToStaticMarkup(await SqueezePage())
    expect(html).not.toContain("collector-held copies.</p>")
    expect(html).not.toContain("Listings as of")
  })
})

describe("registry", () => {
  it("both boards are registered with a public JSON twin", () => {
    expect(getInsightsBoard("candy-serial-premiums")?.publicApi).toBe(true)
    expect(getInsightsBoard("candy-squeeze")?.publicApi).toBe(true)
  })
})

describe("edition page entry points", () => {
  it("Candy edition pages link both boards from 'Featured in Insights'", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8")
    const chips = src.slice(src.indexOf("async function CandyInsightChips"), src.indexOf("async function CandyMarketHistorySection"))
    expect(chips).toContain('href="/insights/candy-serial-premiums"')
    expect(chips).toContain('href="/insights/candy-squeeze"')
  })
})
