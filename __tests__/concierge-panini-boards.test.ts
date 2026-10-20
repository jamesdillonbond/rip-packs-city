// 2026-10-19 — the concierge could read neither the Panini pack market nor the Panini
// premiums boards, and its prompt told users Panini had "no Collection analyzer, no
// Sniper" three weeks after both tabs shipped (09-27 / 09-28). These pin the reads'
// honesty (a failed read is never an empty board), the pack-EV gate (a mean-only edge
// is never "+EV"), and that no prompt sentence denies a tab the registry lists.

import { describe, it, expect, vi, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { publishedCollections } from "@/lib/collections"
import {
  paniniRipVerdict,
  readPaniniPackMarketForConcierge,
  readPaniniPremiumsForConcierge,
  readPaniniDealsForConcierge,
} from "@/lib/concierge/panini-boards"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROUTE = stripComments(readFileSync(join(__dirname, "..", "app", "api", "support-chat", "route.ts"), "utf8"))

afterEach(() => vi.unstubAllGlobals())

describe("paniniRipVerdict — a mean-only edge is never a pack that pays", () => {
  it("the 10-19 WC 1043 shape (+$19 on the mean, typical $8.50 on $200) is positive_on_mean_only", () => {
    expect(paniniRipVerdict({ evModeled: true, costUsd: 200, netRipEdgeUsd: 19, typicalEvUsd: 8.5, sim: null }))
      .toBe("positive_on_mean_only")
  })
  it("a positive mean with a simulated P(pull ≥ cost) of 13 % is positive_on_mean_only", () => {
    expect(paniniRipVerdict({ evModeled: true, costUsd: 134, netRipEdgeUsd: 2, typicalEvUsd: 22, sim: { pBeatCost: 0.1288 } }))
      .toBe("positive_on_mean_only")
  })
  it("only P(pull ≥ cost) ≥ 50 % reads typical_pack_beats_cost", () => {
    expect(paniniRipVerdict({ evModeled: true, costUsd: 10, netRipEdgeUsd: 1, typicalEvUsd: 5, sim: { pBeatCost: 0.5 } }))
      .toBe("typical_pack_beats_cost")
    expect(paniniRipVerdict({ evModeled: true, costUsd: 10, netRipEdgeUsd: 1, typicalEvUsd: 5, sim: { pBeatCost: 0.49 } }))
      .toBe("positive_on_mean_only")
  })
  it("a simulation outranks the typical pull when they disagree", () => {
    expect(paniniRipVerdict({ evModeled: true, costUsd: 10, netRipEdgeUsd: 3, typicalEvUsd: 12, sim: { pBeatCost: 0.2 } }))
      .toBe("positive_on_mean_only")
  })
  it("an unmodelled pack is not_modeled, never no_edge; a missing price is no_price", () => {
    expect(paniniRipVerdict({ evModeled: false, costUsd: 10, netRipEdgeUsd: null })).toBe("not_modeled")
    expect(paniniRipVerdict({ evModeled: null, costUsd: 10, netRipEdgeUsd: 5 })).toBe("not_modeled")
    expect(paniniRipVerdict({ evModeled: true, costUsd: null, netRipEdgeUsd: null })).toBe("no_price")
  })
  it("a negative edge is no_edge", () => {
    expect(paniniRipVerdict({ evModeled: true, costUsd: 99, netRipEdgeUsd: -70, typicalEvUsd: 6 })).toBe("no_edge")
  })
})

describe("readPaniniPackMarketForConcierge", () => {
  it("a 503 is an error payload, never an empty board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })))
    const out = JSON.parse(await readPaniniPackMarketForConcierge("https://x", 20))
    expect(out.status).toBe("error")
    expect(out.rows).toBeUndefined()
    expect(out.count).toBeUndefined()
  })
  it("a payload without products is an error, not zero packs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 200 })))
    const out = JSON.parse(await readPaniniPackMarketForConcierge("https://x", 20))
    expect(out.status).toBe("error")
    expect(out.total_packs).toBeUndefined()
  })
  it("trims to the limit, keeps totals, and withholds EV on unmodelled packs", async () => {
    const products = [
      { id: "1043", name: "WC pack", evModeled: true, costUsd: 200, netRipEdgeUsd: 19, typicalEvUsd: 8.5, actualEvUsd: 218.85, sim: null, stale: false },
      { id: "9", name: "NBA pack", evModeled: false, costUsd: 5, netRipEdgeUsd: 3, typicalEvUsd: 4, actualEvUsd: 8, sim: null, stale: true },
      { id: "10", name: "other", evModeled: false, costUsd: 5 },
    ]
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ products, history: [{ a: 1 }], coverage: null, coverage_error: false }))))
    const out = JSON.parse(await readPaniniPackMarketForConcierge("https://x", 2))
    expect(out.status).toBe("ok")
    expect(out.total_packs).toBe(3)
    expect(out.modeled_packs).toBe(1)
    expect(out.rows).toHaveLength(2)
    expect(out.history).toBeUndefined()
    expect(out.rows[0].rip_verdict).toBe("positive_on_mean_only")
    expect(out.rows[1].rip_verdict).toBe("not_modeled")
    expect(out.rows[1].mean_ev_usd).toBeNull()
    expect(out.rows[1].net_edge_on_mean_usd).toBeNull()
    expect(out.rows[1].stats_stale).toBe(true)
  })
})

describe("readPaniniPremiumsForConcierge", () => {
  function db(result: { data?: unknown[]; error?: { message: string } | null }) {
    const chain: Record<string, unknown> = {}
    for (const k of ["select", "in", "gte", "order"]) chain[k] = () => chain
    chain.limit = async () => ({ data: result.data ?? [], error: result.error ?? null })
    return { from: () => chain }
  }
  it("a failed view read is an error payload, never empty boards", async () => {
    const out = JSON.parse(await readPaniniPremiumsForConcierge(db({ error: { message: "boom" } }), "https://x", 10))
    expect(out.status).toBe("error")
    expect(out.parallels).toBeUndefined()
    expect(out.serials).toBeUndefined()
  })
  it("never forwards an FMV confidence tier (concierge rule 3)", async () => {
    const row = { external_id: "packcard-1", player_name: "P", parallel_confidence: "HIGH", base_confidence: "MEDIUM", premium_mult: 2, sku: "s" }
    const raw = await readPaniniPremiumsForConcierge(db({ data: [row] }), "https://x", 10)
    expect(raw).not.toMatch(/confidence/i)
    expect(raw).not.toMatch(/"HIGH"|"MEDIUM"/)
    expect(JSON.parse(raw).parallels[0].edition_url).toBe("https://x/panini-blockchain/edition/packcard-1")
  })
})

describe("readPaniniDealsForConcierge — the Sniper tab's snapshot, never 'no deals' out of a failed read", () => {
  const deal = (o: Record<string, unknown>) => ({
    sku: "packcard-2420_1_2_3__4_8", player_name: "Caitlin Clark", product_name: "2026 Prizm WNBA", sport: "Womens Basketball",
    parallel: "Silver", ask_usd: 10, fmv_usd: 20, discount_pct: 50, deal_basis: "fmv_only", ...o,
  })
  const snap = (payload: Record<string, unknown>, ageMs = 30 * 60_000) =>
    async () => ({ payload, ageMs, stale: false, refreshedAt: "2026-10-20T01:52:18Z" })

  it("no snapshot is an error, not an empty board", async () => {
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", {}, async () => null))
    expect(out.status).toBe("error")
    expect(out.results).toBeUndefined()
  })
  it("a snapshot whose deal read failed is an error, even with an empty array", async () => {
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", {}, snap({ deals_all: [], deals_all_error: true })))
    expect(out.status).toBe("error")
  })
  it("sale-backed deals lead, then the deepest discount; edition + Panini links derive from the sku", async () => {
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", {}, snap({ deals_all: [
      deal({ sku: "packcard-1_1_1_1__1_5", discount_pct: 80 }),
      deal({ sku: "packcard-2_2_2_2__1_5", discount_pct: 20, deal_basis: "fmv_and_recent_sales" }),
    ] })))
    expect(out.status).toBe("ok")
    expect(out.results.map((r: { discount_pct: number }) => r.discount_pct)).toEqual([20, 80])
    expect(out.results[0].backed_by_recent_sales).toBe(true)
    expect(out.results[0].edition_url).toBe("https://x/panini-blockchain/edition/packcard-2_2_2_2")
    expect(out.results[0].panini_url).toContain("packcard-2_2_2_2")
    expect(out.scope).toBe("every walked Panini product")
  })
  it("filters by player, sport, max price and a fractional or percent minDiscount", async () => {
    const payload = { deals_all: [
      deal({ sku: "packcard-1_1_1_1__1_5", player_name: "Lionel Messi", sport: "Soccer", ask_usd: 500, discount_pct: 30 }),
      deal({ sku: "packcard-2_2_2_2__1_5", discount_pct: 10 }),
      deal({ sku: "packcard-3_3_3_3__1_5", discount_pct: 40 }),
    ] }
    const byPlayer = JSON.parse(await readPaniniDealsForConcierge("https://x", { player: "messi" }, snap(payload)))
    expect(byPlayer.results).toHaveLength(1)
    const bySport = JSON.parse(await readPaniniDealsForConcierge("https://x", { sport: "womens basketball", minDiscount: 0.3 }, snap(payload)))
    expect(bySport.results.map((r: { discount_pct: number }) => r.discount_pct)).toEqual([40])
    const cheap = JSON.parse(await readPaniniDealsForConcierge("https://x", { maxPrice: 100, minDiscount: 30 }, snap(payload)))
    expect(cheap.matched).toBe(1)
  })
  it("a filter that matches nothing says no_matching_deals with the board total, never an empty ok", async () => {
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", { player: "nobody" }, snap({ deals_all: [deal({})] })))
    expect(out.status).toBe("no_matching_deals")
    expect(out.board_total).toBe(1)
  })
  it("an old snapshot is flagged stale and carries its age", async () => {
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", {}, snap({ deals_all: [deal({})] }, 5 * 3_600_000)))
    expect(out.snapshot_stale).toBe(true)
    expect(out.snapshot_age_hours).toBe(5)
  })
})

describe("the concierge prompt never denies a tab the registry lists", () => {
  const CLAIMS: Array<[string, RegExp]> = [
    ["collection", /\bno Collection (analy[sz]er|tab)\b/i],
    ["sniper", /\bno Sniper\b/i],
    ["packs", /\bno Packs? tab\b/i],
    ["sets", /\bno Sets? (tab|tracker)\b/i],
    ["analytics", /\bno Analytics tab\b/i],
  ]
  it("no sentence naming a published collection says it lacks a tab it has", () => {
    const sentences = ROUTE.split(/(?<=[.!?])\s+/)
    for (const c of publishedCollections()) {
      const names = [c.label, c.shortLabel].filter(Boolean).map((n) => n!.toLowerCase())
      for (const s of sentences) {
        // A sentence about ONE collection: names it and no other published collection.
        const lower = s.toLowerCase()
        if (!names.some((n) => lower.includes(n))) continue
        for (const [page, re] of CLAIMS) {
          if ((c.pages as readonly string[]).includes(page)) expect(s, `${c.id} has a ${page} tab`).not.toMatch(re)
        }
      }
    }
  })
  it("planted: the pre-fix sentence is caught", () => {
    const planted = "Panini is a published collection with these tabs: x (no Collection analyzer, no Sniper), plus its board."
    expect(planted).toMatch(CLAIMS[0][1])
    expect(planted).toMatch(CLAIMS[1][1])
    expect(publishedCollections().find((c) => c.id === "panini-blockchain")?.pages).toEqual(expect.arrayContaining(["collection", "sniper"]))
  })
  it("both new boards are in the tool's enum and dispatched", () => {
    expect(ROUTE).toMatch(/"panini_pack_market", "panini_premiums"/)
    expect(ROUTE).toContain('toolInput.board === "panini_pack_market"')
    expect(ROUTE).toContain('toolInput.board === "panini_premiums"')
  })
  it("Panini-scoped search_live_deals / search_catalog_deals read the Panini snapshot before any Flow source", () => {
    for (const tool of ["search_live_deals", "search_catalog_deals"]) {
      const i = ROUTE.indexOf(`if (toolName === "${tool}")`)
      expect(i, tool).toBeGreaterThan(0)
      const head = ROUTE.slice(i, i + 900)
      expect(head, tool).toContain('effectiveCollectionId === "panini-blockchain"')
      expect(head, tool).toContain("readPaniniDealsForConcierge(")
      const flow = Math.min(...["/api/sniper-feed", '.from("cached_listings")', "isPinnacle("].map((k) => { const j = ROUTE.indexOf(k, i); return j < 0 ? Infinity : j }))
      expect(ROUTE.indexOf("readPaniniDealsForConcierge(", i), tool).toBeLessThan(flow)
    }
  })
  it("a Panini-scoped compare_pack_value answers from Panini's pack plane, not the empty Flow table", () => {
    const i = ROUTE.indexOf('if (toolName === "compare_pack_value")')
    const j = ROUTE.indexOf('.from("pack_table_rows")', i)
    expect(i).toBeGreaterThan(0)
    const head = ROUTE.slice(i, j)
    expect(head).toContain('toolInput.collectionId === "panini-blockchain"')
    expect(head).toContain("readPaniniPackMarketForConcierge(")
  })
})
