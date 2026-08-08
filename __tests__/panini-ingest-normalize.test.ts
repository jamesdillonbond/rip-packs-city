import { describe, it, expect } from "vitest"
import { parallelFamily, toEditionRow, toFmvRow, toPackRow, toSerialRow, toSaleTimestamp, toSaleRecord, latestSalesBySku, isStrictIsoUtc, PANINI_UUID } from "@/lib/chains/panini/ingest-normalize"

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

// nftSalesData — the realized-sale path that replaced brought_at_price (dead upstream since
// 2026-07-29; the 2026-08-08 listType A/B proved no request shape recovers it).
describe("toSaleTimestamp", () => {
  it("stamps a zone-less Panini date as UTC (the shape nftSalesData actually sends)", () => {
    // Left unlabelled this would be read in whatever zone the writer assumes — hours off, and
    // indistinguishable from a real price move on a chart.
    expect(toSaleTimestamp("2026-08-02 10:08:02")).toBe("2026-08-02T10:08:02Z")
    expect(toSaleTimestamp("2026-08-02T10:08")).toBe("2026-08-02T10:08Z")
  })
  it("passes through a stamp that already carries a zone", () => {
    expect(toSaleTimestamp("2026-06-24T21:31:15Z")).toBe("2026-06-24T21:31:15Z")
    expect(toSaleTimestamp("2026-06-24T21:31:15+00:00")).toBe("2026-06-24T21:31:15+00:00")
  })
  it("nulls empties and hands anything unrecognised through untouched", () => {
    expect(toSaleTimestamp(null)).toBeNull()
    expect(toSaleTimestamp("  ")).toBeNull()
    expect(toSaleTimestamp("last tuesday")).toBe("last tuesday")
  })
})

describe("toSaleRecord", () => {
  it("maps a live nftSalesData record onto the serial sku verbatim", () => {
    // url_key is byte-identical to panini_card_serials.sku — verified live against
    // packcard-2332_486956_12680604_40__10_10, so the join needs no mapping.
    const r = toSaleRecord({
      url_key: "packcard-2332_486956_12680604_40__10_10", txn_amount: 22500,
      purchased_date: "2026-08-02 10:08:02", buyer_name: "spinotron", seller_name: "billoBanked",
      transaction_hash: "0xabc", sale_type: "Marketplace",
    })
    expect(r).toEqual({ sku: "packcard-2332_486956_12680604_40__10_10", amount_usd: 22500, sold_at: "2026-08-02T10:08:02Z" })
  })
  it("rejects records with no sku or no positive amount", () => {
    expect(toSaleRecord({ txn_amount: 100 })).toBeNull()
    expect(toSaleRecord({ url_key: "s" })).toBeNull()
    expect(toSaleRecord({ url_key: "s", txn_amount: 0 })).toBeNull()
    expect(toSaleRecord({ url_key: "", txn_amount: 5 })).toBeNull()
  })
  it("accepts amount/date alternates and keeps an undated sale", () => {
    expect(toSaleRecord({ sku: "s", amount: 12 })).toEqual({ sku: "s", amount_usd: 12, sold_at: null })
    expect(toSaleRecord({ url_key: "s", sale_price: 7, txn_date: "2026-01-02 03:04:05" })!.sold_at).toBe("2026-01-02T03:04:05Z")
  })
})

describe("latestSalesBySku", () => {
  it("keeps the NEWEST sale per sku — that is what last_sale means", () => {
    const m = latestSalesBySku([
      { url_key: "a", txn_amount: 20000, purchased_date: "2026-06-24 21:31:15" },
      { url_key: "a", txn_amount: 22500, purchased_date: "2026-08-02 10:08:02" },
      { url_key: "a", txn_amount: 26000, purchased_date: "2026-05-01 00:00:00" },
      { url_key: "b", txn_amount: 5, purchased_date: "2026-08-01 00:00:00" },
    ])
    expect(m.size).toBe(2)
    expect(m.get("a")).toMatchObject({ amount_usd: 22500, sold_at: "2026-08-02T10:08:02Z" })
    expect(m.get("b")!.amount_usd).toBe(5)
  })
  it("compares real instants, not strings, across mixed zone formats", () => {
    const m = latestSalesBySku([
      { url_key: "a", txn_amount: 1, purchased_date: "2026-08-02T10:08:02+00:00" },
      { url_key: "a", txn_amount: 2, purchased_date: "2026-08-02 11:00:00" },
    ])
    expect(m.get("a")!.amount_usd).toBe(2)
  })
  it("never lets an undated record displace a dated one, and drops junk", () => {
    const m = latestSalesBySku([
      { url_key: "a", txn_amount: 100, purchased_date: "2026-07-01 00:00:00" },
      { url_key: "a", txn_amount: 999 }, // undated — must not win
      { url_key: "b", txn_amount: 0 }, // unpriced — dropped entirely
      null,
    ] as any[])
    expect(m.get("a")!.amount_usd).toBe(100)
    expect(m.has("b")).toBe(false)
  })
  it("takes the first of two undated records and tolerates an empty batch", () => {
    expect(latestSalesBySku([{ url_key: "a", txn_amount: 1 }, { url_key: "a", txn_amount: 2 }]).get("a")!.amount_usd).toBe(1)
    expect(latestSalesBySku([]).size).toBe(0)
    expect(latestSalesBySku(undefined as any).size).toBe(0)
  })
})

describe("isStrictIsoUtc", () => {
  it("accepts only a zone-explicit ISO-UTC stamp (it gates a PostgREST filter string)", () => {
    expect(isStrictIsoUtc("2026-08-02T10:08:02Z")).toBe(true)
    expect(isStrictIsoUtc("2026-08-02T10:08Z")).toBe(true)
    expect(isStrictIsoUtc("2026-08-02T10:08:02.123456Z")).toBe(true)
  })
  it("rejects anything that could shape a filter expression", () => {
    expect(isStrictIsoUtc(null)).toBe(false)
    expect(isStrictIsoUtc("2026-08-02 10:08:02")).toBe(false)
    expect(isStrictIsoUtc("2026-08-02T10:08:02+00:00")).toBe(false)
    expect(isStrictIsoUtc("2026-08-02T10:08:02Z,id.gt.0")).toBe(false)
    expect(isStrictIsoUtc("last tuesday")).toBe(false)
  })
})
