import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/panini-pack-market — Panini Packs tab backend (2026-09-27).
 *
 * Stated as the ABSENCE of false claims: a failed EV read must not render a
 * zeroed board, a failed secondary read must not read as "none", a price the
 * runner last refreshed days ago must not read as the live price, and a cost
 * that is an average sale must not read as a floor.
 */

type Res = { data: unknown; error: unknown }
const state: Record<string, Res> = {}

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      gte: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: any) => resolve(state[table] ?? { data: [], error: null }),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { GET, PANINI_PACK_STALE_HOURS } from "@/app/api/panini-pack-market/route"
import { parsePackDetails } from "@/lib/panini/pack-market"

const FRESH = new Date(Date.now() - 2 * 3_600_000).toISOString()
const STALE = new Date(Date.now() - (PANINI_PACK_STALE_HOURS + 30) * 3_600_000).toISOString()

const HOBBY = {
  id: "1038", pack_type: "hobby", pack_cost_usd: 144, floor_usd: 144, avg_sale_usd: 112.38, recent_sale_usd: 142,
  cards_per_pack: 4, packs_total: 50480, packs_remaining: 5785, packs_ripped_pct: 88.5, actual_ev_usd: 150,
  typical_ev_usd: 30, silver_ev: 4, base_parallel_ev: 65, insert_ev: 91, fotl_exclusive_ev: 114,
  net_rip_edge_usd: 6, model_note: "panini-pack-ev-0.4 · REMAINING-BASIS", updated_at: FRESH,
  // Re-pinned 2026-09-28: the board carries product identity, and EV is served only where the view
  // says the model applies (ev_modeled). WC is the modeled product.
  product_name: "2026 Panini NFT Prizm World Cup Soccer", sport: "SOCCER", product_set_id: 2332, ev_modeled: true,
}
const FOTL = { ...HOBBY, id: "1039", pack_type: "fotl", cards_per_pack: 5, pack_cost_usd: 261, floor_usd: 261, updated_at: FRESH }

const RAW = {
  pack_name: "2026 Panini NFT Prizm World Cup Soccer Packs",
  pack_img: "pack/pack_enh_bc_1038.png",
  pack_label: [
    { label: "GUARANTEED", children: ["2 Base Silver cards (each #/259)", "1 Other Card"] },
    { label: "PACK ODDS", children: ["An Insert falls in 7 out of every 20 packs"] },
    { label: "EMPTY", children: [] },
  ],
  market_stats: { top_sale: 265, pack_auction_count: 498 },
}

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k]
  state.panini_pack_ev_board = { data: [FOTL, HOBBY], error: null }
  state.panini_pack_state = { data: [{ id: "1038", pack_type: "hobby", raw: RAW }, { id: "1039", pack_type: "fotl", raw: {} }], error: null }
  state.panini_pack_state_history = {
    data: [{ pack_type: "hobby", observed_at: FRESH, floor_usd: 144, recent_sale_usd: 142, avg_sale_usd: 112.38, packs_remaining: 5785 }],
    error: null,
  }
  state.panini_coverage_summary = { data: [{ total_editions: 5100, pct_trustworthy: 35, edition_age_p50_h: 30 }], error: null }
})

async function body() {
  const res = await GET()
  return { status: res.status, json: await res.json() }
}

describe("GET /api/panini-pack-market", () => {
  it("serves both products with typical pull, mean EV and Panini's own market stats", async () => {
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.products.map((p: any) => p.label)).toEqual(["FOTL", "Hobby"])
    const hobby = json.products.find((p: any) => p.packType === "hobby")
    expect(hobby).toMatchObject({ costUsd: 144, costBasis: "floor", typicalEvUsd: 30, actualEvUsd: 150, topSaleUsd: 265, listedCount: 498, stale: false })
    expect(hobby.name).toBe(RAW.pack_name)
    expect(hobby.imageUrl).toBe("https://assets.paniniamerica.net/catalog/product/pack/pack_enh_bc_1038.png")
    // FOTL's raw has no pack_img — no image, not a guessed one.
    expect(json.products.find((p: any) => p.packType === "fotl").imageUrl).toBeNull()
    // The FOTL-exclusive leg belongs to FOTL only.
    expect(hobby.legs.fotlExclusive).toBeNull()
    expect(json.products.find((p: any) => p.packType === "fotl").legs.fotlExclusive).toBe(114)
    expect(json.coverage.total_editions).toBe(5100)
    expect(json.coverage_error).toBe(false)
  })

  it("a failed EV read is a 503 — never an empty or zeroed board", async () => {
    state.panini_pack_ev_board = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const { status, json } = await body()
    expect(status).toBe(503)
    expect(json.products).toBeUndefined()
    // …and the driver text never reaches the client.
    expect(JSON.stringify(json)).not.toContain("canceling statement")
  })

  it("market stats older than the stale bound are flagged, not served as the live price", async () => {
    state.panini_pack_ev_board = { data: [{ ...HOBBY, updated_at: STALE }], error: null }
    const { json } = await body()
    expect(json.products[0].stale).toBe(true)
    expect(json.stale_after_hours).toBe(PANINI_PACK_STALE_HOURS)
  })

  it("a product with no refresh stamp is stale, not fresh", async () => {
    state.panini_pack_ev_board = { data: [{ ...HOBBY, updated_at: null }], error: null }
    const { json } = await body()
    expect(json.products[0].stale).toBe(true)
  })

  it("with no floor, the cost is labelled an AVERAGE SALE, not a floor", async () => {
    state.panini_pack_ev_board = { data: [{ ...HOBBY, floor_usd: null, pack_cost_usd: 112.38 }], error: null }
    const { json } = await body()
    expect(json.products[0]).toMatchObject({ costUsd: 112.38, costBasis: "avg_sale", floorUsd: null })
  })

  it("a failed history read is `history: null` + history_error — not an empty trail", async () => {
    state.panini_pack_state_history = { data: null, error: { message: "boom" } }
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.history).toBeNull()
    expect(json.history_error).toBe(true)
  })

  it("a successful empty history is [] with no error flag (the control)", async () => {
    state.panini_pack_state_history = { data: [], error: null }
    const { json } = await body()
    expect(json.history).toEqual([])
    expect(json.history_error).toBe(false)
  })

  it("a failed product-details read flags itself and blanks only the details", async () => {
    state.panini_pack_state = { data: null, error: { message: "boom" } }
    const { json } = await body()
    expect(json.details_error).toBe(true)
    const hobby = json.products.find((p: any) => p.packType === "hobby")
    expect(hobby.topSaleUsd).toBeNull()
    expect(hobby.labels).toEqual([])
    // The primary figures still render.
    expect(hobby.typicalEvUsd).toBe(30)
  })

  it("a failed coverage read drops the figures and says so", async () => {
    state.panini_coverage_summary = { data: null, error: { message: "boom" } }
    const { json } = await body()
    expect(json.coverage).toBeNull()
    expect(json.coverage_error).toBe(true)
  })
})

describe("parsePackDetails", () => {
  it("keeps labels with lines, drops empty ones, and reads market stats", () => {
    const d = parsePackDetails(RAW)
    expect(d.labels.map((l) => l.label)).toEqual(["GUARANTEED", "PACK ODDS"])
    expect(d.topSaleUsd).toBe(265)
    expect(d.listedCount).toBe(498)
  })

  it("an unreadable raw payload yields nulls, never zeros", () => {
    for (const raw of [null, "x", {}, { market_stats: { top_sale: "" } }]) {
      const d = parsePackDetails(raw)
      expect(d.topSaleUsd).toBeNull()
      expect(d.listedCount).toBeNull()
      expect(d.name).toBeNull()
    }
  })
})

// Multi-product (2026-09-28). The board now carries packs of products the pack-EV model does not
// price. The substitution this pins: a WNBA pack must never show a number — not WC's EV (the view's
// old CROSS JOIN), not $0 — and must say it is not modeled. The route is the second line of defence:
// it serves EV only on an explicit ev_modeled=true, so a view regression cannot leak figures.
describe("GET /api/panini-pack-market — products the model does not price", () => {
  const WNBA = {
    ...FOTL, id: "PZM-WNBA-FOTL", product_name: "2026 Panini NFT Prizm WNBA", sport: "BASKETBALL", product_set_id: null,
    ev_modeled: false, model_note: "not modeled · no pack-EV model exists for this product yet",
    // Deliberately leaked EV figures, as a regressed view would serve them — the route must drop them.
    actual_ev_usd: 150, typical_ev_usd: 30, net_rip_edge_usd: 6,
  }

  it("serves the pack's market stats but NO EV figure, and flags it not modeled", async () => {
    state.panini_pack_ev_board = { data: [WNBA, HOBBY], error: null }
    const { json } = await body()
    const w = json.products.find((p: any) => p.id === "PZM-WNBA-FOTL")
    expect(w.evModeled).toBe(false)
    expect(w.costUsd).toBe(261)
    expect(w.typicalEvUsd).toBeNull()
    expect(w.actualEvUsd).toBeNull()
    expect(w.netRipEdgeUsd).toBeNull()
    expect(Object.values(w.legs).every((v) => v === null)).toBe(true)
    expect(w.productName).toBe("2026 Panini NFT Prizm WNBA")
  })

  it("a row with no ev_modeled column at all is treated as NOT modeled (strict)", async () => {
    const legacy: Record<string, unknown> = { ...HOBBY }
    delete legacy.ev_modeled
    state.panini_pack_ev_board = { data: [legacy], error: null }
    const { json } = await body()
    expect(json.products[0].evModeled).toBe(false)
    expect(json.products[0].actualEvUsd).toBeNull()
  })

  it("orders the modeled (WC) packs first", async () => {
    state.panini_pack_ev_board = { data: [WNBA, FOTL, HOBBY], error: null }
    const { json } = await body()
    // WC first; within a product, pack_type order (fotl < hobby) — what the view's ORDER BY served before.
    expect(json.products.map((p: any) => p.id)).toEqual(["1039", "1038", "PZM-WNBA-FOTL"])
  })
})

