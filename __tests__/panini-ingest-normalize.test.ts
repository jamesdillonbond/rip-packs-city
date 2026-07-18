import { describe, it, expect } from "vitest"
import { parallelFamily, toEditionRow, toFmvRow, toPackRow, toSerialRow, PANINI_UUID } from "@/lib/chains/panini/ingest-normalize"

const NOW = "2026-07-16T00:00:00.000Z"

describe("parallelFamily", () => {
  it("classifies FOTL exclusives", () => {
    expect(parallelFamily("Base Prizms Aguila")).toBe("fotl_exclusive")
    expect(parallelFamily("Base Prizms Maple Leaf")).toBe("fotl_exclusive")
    expect(parallelFamily("Base Choice Prizms Nebula")).toBe("fotl_exclusive")
  })
  it("classifies base / tiered / insert", () => {
    expect(parallelFamily("Base Prizms Red")).toBe("base")
    expect(parallelFamily("Base Prizms Silver")).toBe("base") // 'base' wins before 'silver'
    expect(parallelFamily("Scorers Club Prizms Gold")).toBe("tiered_insert")
    expect(parallelFamily("Manga")).toBe("non_tiered_insert")
  })
})

describe("toEditionRow", () => {
  it("maps rarity->tier, nested market_stats, and residual counts", () => {
    const r = toEditionRow({ psku: "packcard-2332_1_1_13", athlete: "A", cardset: "Base Prizms Red", card_rarity: "Rare", end_seq: 124, market_stats: { with_collectors_count: 108, unopened_pack_count: 16, floor_price: 5 } }, NOW)
    expect(r.tier).toBe("RARE")
    expect(r.mint_cap).toBe(124)
    expect(r.pulled_count).toBe(108)
    expect(r.still_in_packs).toBe(16)
    expect(r.serial_low_ask_usd).toBe(5)
    expect(r.collection_id).toBe(PANINI_UUID)
    expect(r.parallel_family).toBe("base")
  })
  it("reads market fields at TOP LEVEL when market_stats absent (live grid shape)", () => {
    const r = toEditionRow({ psku: "p", cardset: "Base Prizms Silver", rarity: "Uncommon", end_seq: 259, with_collectors_count: 201, unopened_pack_count: 58 }, NOW)
    expect(r.tier).toBe("COMMON")
    expect(r.pulled_count).toBe(201)
    expect(r.still_in_packs).toBe(58)
  })
  it("prefers __nation (runner tag) then team then nation", () => {
    expect(toEditionRow({ psku: "p", __nation: "Brazil", team: "X" }, NOW).nation).toBe("Brazil")
    expect(toEditionRow({ psku: "p", team: "Portugal" }, NOW).nation).toBe("Portugal")
    expect(toEditionRow({ psku: "p" }, NOW).nation).toBeNull()
  })
  it("flags FOTL exclusives and defaults residuals to 0", () => {
    const r = toEditionRow({ psku: "p", cardset: "Base Prizms Old Glory" }, NOW)
    expect(r.is_fotl_exclusive).toBe(true)
    expect(r.pulled_count).toBe(0)
    expect(r.still_in_packs).toBe(0)
  })
})

describe("toFmvRow", () => {
  it("HIGH when >=3 sales, using avg_sale", () => {
    const r = toFmvRow({ psku: "p", market_stats: { volume_txns: 4, recent_sale: 20, avg_sale: 27.5 } }, NOW)
    expect(r).toMatchObject({ fmv_usd: 27.5, confidence: "HIGH", algo_version: "panini-1.0.0" })
  })
  it("MEDIUM/LOW by txn count", () => {
    expect(toFmvRow({ psku: "p", market_stats: { volume_txns: 2, recent_sale: 10, avg_sale: 10 } }, NOW)!.confidence).toBe("MEDIUM")
    expect(toFmvRow({ psku: "p", market_stats: { volume_txns: 1, recent_sale: 10, avg_sale: 10 } }, NOW)!.confidence).toBe("LOW")
  })
  it("ASK_ONLY floor*0.9 when no sales, null when neither", () => {
    const ask = toFmvRow({ psku: "p", market_stats: { volume_txns: 0, floor_price: 100 } }, NOW)!
    expect(ask.confidence).toBe("ASK_ONLY")
    expect(ask.fmv_usd).toBe(90)
    expect(toFmvRow({ psku: "p", market_stats: { volume_txns: 0, floor_price: 0 } }, NOW)).toBeNull()
  })
})

describe("toPackRow", () => {
  it("prefers __pack_id and tags 1039 as FOTL", () => {
    const r = toPackRow({ __pack_id: "1039", pack_name: "WC Prizm", total_pack_qty: 500, market_stats: { unopen_pack_count: 100, floor_price: 249, avg_sale: 106 } }, NOW)
    expect(r.id).toBe("1039")
    expect(r.pack_type).toBe("fotl")
    expect(r.packs_total).toBe(500)
    expect(r.packs_remaining).toBe(100)
    expect(r.floor_usd).toBe(249)
    expect(r.avg_sale_usd).toBe(106)
    expect(r.raw).toBeTruthy()
  })
  it("defaults to hobby and captures top-level price fields", () => {
    const r = toPackRow({ pack_sku: "1038", total_pack_qty: 50480, unopen_pack_count: 9504, floor_price: 249 }, NOW)
    expect(r.id).toBe("1038")
    expect(r.pack_type).toBe("hobby")
    expect(r.packs_remaining).toBe(9504)
    expect(r.floor_usd).toBe(249)
  })
})

describe("toSerialRow", () => {
  it("captures special flags, demand + last-sale, and listed status", () => {
    const r = toSerialRow({ sku: "packcard-2332_1_1_5", psku: "packcard-2332_1_1", nft_type: "rookie card,number 1", buy_now_price: 250, best_offer: 40, brought_at_price: 200, brought_at_time: "2026-06-01T00:00:00Z", state: "AVAILABLE", owner: "bob" }, NOW)
    expect(r.nft_type).toBe("rookie card,number 1")
    expect(r.price_usd).toBe(250)
    expect(r.best_offer_usd).toBe(40)
    expect(r.last_sale_usd).toBe(200)
    expect(r.is_listed).toBe(true)
    expect(r.owner).toBe("bob")
    expect(r.edition_external_id).toBe("packcard-2332_1_1")
  })
  it("nulls best_offer / last_sale when 0 (pack-pulled, no offer)", () => {
    const r = toSerialRow({ sku: "s_10_25", best_offer: 0, brought_at_price: 0 }, NOW)
    expect(r.best_offer_usd).toBeNull()
    expect(r.last_sale_usd).toBeNull()
  })
  it("parses serial + cap from the sku suffix when fields absent", () => {
    const r = toSerialRow({ sku: "packcard-2332_486967_12675181_118_7_10" }, NOW)
    expect(r.serial_number).toBe(7)
    expect(r.mint_cap).toBe(10)
  })
  it("walks the price ladder (buy_now -> price -> final -> amount)", () => {
    expect(toSerialRow({ sku: "s", price: 12 }, NOW).price_usd).toBe(12)
    expect(toSerialRow({ sku: "s", amount: 9 }, NOW).price_usd).toBe(9)
  })
})
