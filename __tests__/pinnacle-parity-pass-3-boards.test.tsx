import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { NextRequest } from "next/server"

// 2026-11-23 parity pass 3: Pinnacle serial-premiums + squeeze boards, and Pinnacle joining the RPC Index.
// Pins: a failed read is never an empty board; an unknown premium is "—" (never 1.0×); a squeeze row's "0 listed"
// carries the sweep's time; the index config has a Pinnacle leg whose Legendary line is NOT plotted.

let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
let lastRpc: { fn: string; args: unknown } | null = null
vi.mock("@/lib/supabase", () => {
  const admin = {
    rpc: async (fn: string, args: unknown) => { lastRpc = { fn, args }; return rpcResult },
    from: () => { throw new Error("no table reads") },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { shapeSerialPremiums, shapeSqueeze, num } from "@/lib/insights/pinnacle-boards"
import { fmtMultiplier, fmtBoardUsd } from "@/lib/insights/pinnacle-board-format"
import { GET as serialGET } from "@/app/api/public/insights/pinnacle-serial-premiums/route"
import { GET as squeezeGET } from "@/app/api/public/insights/pinnacle-squeeze/route"
import SerialPage from "@/app/insights/pinnacle-serial-premiums/page"
import SqueezePage from "@/app/insights/pinnacle-squeeze/page"
import {
  MARKET_INDEX_COLLECTIONS,
  isMarketIndexCollection,
  marketIndexConfig,
  otherMarketIndexes,
} from "@/lib/insights/market-index-collections"

const serialRow = {
  render_id: "LGEV2-DVHA-URSU-S8", name: "Ursula", set_name: "Villains", edition_type: "Legendary Edition",
  variant: "Xenith", total_minted: 10, serial_number: 10, band: "perfect", price_usd: 925,
  sold_at: "2026-11-07T19:41:56Z", n_comps: 1, comp_median_usd: null, multiplier: null,
}
const serialRow2 = { ...serialRow, render_id: "LEV1-X", name: "Stitch", serial_number: 1, band: "first", n_comps: 5, comp_median_usd: 20, multiplier: 15.36 }
const squeezeRow = {
  render_id: "OEV1-GARG-DEMO-S5", character_name: "Demona", set_name: "Gargoyles", edition_type: "Open Edition",
  variant: "Digital Display", is_chaser: true, thumbnail_url: null, minted: 49, burned: 0, issuer_held: 20,
  collector_held: 29, listed: 0, pct_listed: 0, floor_ask_usd: null, fmv_usd: 49, sales_30d: 14,
}

beforeEach(() => { rpcResult = { data: null, error: null }; lastRpc = null })

describe("shapes", () => {
  it("keep NULLs null and refuse a non-payload", () => {
    const p = shapeSerialPremiums({ stats: [], rows: [serialRow] })
    expect(p.rows[0].multiplier).toBeNull()
    expect(p.rows[0].comp_median_usd).toBeNull()
    expect(() => shapeSerialPremiums(null)).toThrow()
    expect(() => shapeSqueeze({ nope: 1 })).toThrow()
    expect(shapeSqueeze({ rows: [squeezeRow], listings_seen_at: "x" }).rows[0].floor_ask_usd).toBeNull()
    expect(num(undefined)).toBeNull()
  })
  it("format unknowns as an em-dash, never 1.0× / $0", () => {
    expect(fmtMultiplier(null)).toBe("—")
    expect(fmtMultiplier(15.36)).toBe("15.4×")
    expect(fmtMultiplier(3.56)).toBe("3.56×")
    expect(fmtBoardUsd(null)).toBe("—")
  })
})

describe("routes", () => {
  it("serial premiums: rows on success, 5xx (never an empty board) on failure", async () => {
    rpcResult = { data: { stats: [], rows: [serialRow] }, error: null }
    const ok = await serialGET()
    expect(ok.status).toBe(200)
    expect((await ok.json()).rows).toHaveLength(1)
    rpcResult = { data: null, error: { message: "down" } }
    const bad = await serialGET()
    expect(bad.status).toBeGreaterThanOrEqual(500)
    expect((await bad.json()).rows).toBeUndefined()
  })
  it("squeeze: passes the filters, 400s a malformed one, 5xx on failure", async () => {
    rpcResult = { data: { listings_seen_at: "2026-11-23T21:37:47Z", min_held: 50, pins_ranked: 1, pins_zero_listed: 1, rows: [squeezeRow] }, error: null }
    const ok = await squeezeGET(new NextRequest("https://t/api/public/insights/pinnacle-squeeze?min_held=50&limit=10"))
    expect(ok.status).toBe(200)
    expect(lastRpc).toEqual({ fn: "get_pinnacle_listed_squeeze", args: { p_min_held: 50, p_limit: 10 } })
    const body = await ok.json()
    expect(body.meta.listings_seen_at).toBe("2026-11-23T21:37:47Z")
    const bad = await squeezeGET(new NextRequest("https://t/api/public/insights/pinnacle-squeeze?min_held=-1"))
    expect(bad.status).toBe(400)
    rpcResult = { data: null, error: { message: "down" } }
    const down = await squeezeGET(new NextRequest("https://t/api/public/insights/pinnacle-squeeze"))
    expect(down.status).toBeGreaterThanOrEqual(500)
  })
})

describe("pages", () => {
  it("serial premiums renders rows; a premium without comparables reads '—' and 'too few'", async () => {
    rpcResult = { data: { stats: [{ band: "first", sales: 112, with_comps: 103, median_multiplier: 15.36 }], rows: [serialRow, serialRow2] }, error: null }
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).toContain("Ursula")
    expect(html).toContain("too few")
    expect(html).toContain("15.4×")
    expect(html).not.toContain("1.00×")
  })
  it("serial premiums on a failed read does not say 'no sale on record'", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = renderToStaticMarkup(await SerialPage())
    expect(html).not.toContain("No #1 or perfect-serial sale on record")
  })
  it("squeeze dates the sweep and says 'none listed', never $0 for a missing floor", async () => {
    rpcResult = { data: { listings_seen_at: "2026-11-23T21:37:47Z", min_held: 25, pins_ranked: 1, pins_zero_listed: 1, rows: [squeezeRow] }, error: null }
    const html = renderToStaticMarkup(await SqueezePage())
    expect(html).toContain("Listings as of Nov 23")
    expect(html).toContain("none listed")
    expect(html).not.toContain("$0.00")
  })
  it("squeeze on a failed read claims nothing about supply", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = renderToStaticMarkup(await SqueezePage())
    expect(html).not.toContain("No pin has")
    expect(html).not.toContain("Listings as of")
  })
})

describe("RPC Index — Pinnacle leg", () => {
  it("is a market-index collection with its own URL and an edition-type view", () => {
    expect(MARKET_INDEX_COLLECTIONS).toContain("disney-pinnacle")
    expect(isMarketIndexCollection("disney-pinnacle")).toBe(true)
    const c = marketIndexConfig("disney-pinnacle")
    expect(c.view).toBe("pinnacle_market_index_daily")
    expect(c.path).toBe("/insights/pinnacle-market")
    expect(c.plotTiers).toEqual(["LIMITED", "OPEN"])
    expect(c.plotTiers).not.toContain("LEGENDARY")
    expect(c.validTiers).toContain("LEGENDARY")
    for (const t of c.plotTiers) expect(c.tierHex[t]).toMatch(/^#[0-9A-F]{6}$/i)
  })
  it("every index links the other two", () => {
    expect(otherMarketIndexes("disney-pinnacle").map((o) => o.path)).toEqual(["/insights/market", "/insights/allday-market"])
    expect(otherMarketIndexes("nba-top-shot").map((o) => o.path)).toEqual(["/insights/allday-market", "/insights/pinnacle-market"])
  })
})
