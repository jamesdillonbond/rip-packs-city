import { describe, it, expect } from "vitest"
import {
  buildPaniniCollectionCsv,
  filterSortPaniniCards,
  paniniCardSports,
  EMPTY_PANINI_CARD_FILTER,
  PANINI_COLLECTION_CSV_HEADERS,
} from "@/lib/panini/collection-view"
import type { PaniniOwnerCard } from "@/lib/panini/owner-cards"

function card(over: Partial<PaniniOwnerCard>): PaniniOwnerCard {
  return {
    sku: "s", editionKey: "packcard-1", serial: 1, mintCap: 10, isListed: false, askUsd: null, lastSaleUsd: null,
    lastSaleAt: null, seenAt: null, flags: [], playerName: "P", setName: "Base", tier: null, thumbnailUrl: null,
    fmvUsd: 10, catalogued: true, sport: "Soccer", ...over,
  }
}
const CARDS = [
  card({ sku: "a", playerName: "Luka Dončić", setName: "Base Prizms", fmvUsd: 50, serial: 9, sport: "Basketball", isListed: true, askUsd: 60 }),
  card({ sku: "b", playerName: "Caitlin Clark", setName: "Gold", fmvUsd: null, catalogued: false, serial: 2, sport: "Womens Basketball" }),
  card({ sku: "c", playerName: "Lionel Messi", setName: "Gold", fmvUsd: 650, serial: 1, flags: ["#1"], isListed: true, askUsd: 900 }),
  card({ sku: "d", playerName: "Erling Haaland", setName: "Base", fmvUsd: 5, serial: null, isListed: false, askUsd: 7 }),
]
const ids = (cs: PaniniOwnerCard[]) => cs.map((c) => c.sku).join("")

describe("filterSortPaniniCards", () => {
  it("an unpriced card sorts LAST in both FMV directions — never as $0", () => {
    expect(ids(filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "fmv_desc"))).toBe("cadb")
    expect(ids(filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "fmv_asc"))).toBe("dacb")
  })
  it("listed-price sort and the Listed filter use only a LISTED card's ask (an ask on an unlisted card is stale)", () => {
    expect(ids(filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "ask_asc"))).toBe("acbd")
    expect(ids(filterSortPaniniCards(CARDS, { ...EMPTY_PANINI_CARD_FILTER, listedOnly: true }, "fmv_desc"))).toBe("ca")
  })
  it("search is accent- and case-blind over player and card name; sport filter uses the shown label", () => {
    expect(ids(filterSortPaniniCards(CARDS, { ...EMPTY_PANINI_CARD_FILTER, query: "doncic" }, "fmv_desc"))).toBe("a")
    expect(ids(filterSortPaniniCards(CARDS, { ...EMPTY_PANINI_CARD_FILTER, query: "gold" }, "player_asc"))).toBe("bc")
    expect(ids(filterSortPaniniCards(CARDS, { ...EMPTY_PANINI_CARD_FILTER, sport: "WNBA" }, "fmv_desc"))).toBe("b")
    expect(ids(filterSortPaniniCards(CARDS, { ...EMPTY_PANINI_CARD_FILTER, specialOnly: true }, "fmv_desc"))).toBe("c")
  })
  it("serial sort puts a card with no serial last", () => {
    expect(ids(filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "serial_asc"))).toBe("cbad")
  })
  it("does not mutate its input", () => {
    const before = ids(CARDS)
    filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "player_asc")
    expect(ids(CARDS)).toBe(before)
  })
})

describe("paniniCardSports", () => {
  it("lists shown labels — WNBA, never 'Womens Basketball'", () => {
    expect(paniniCardSports(CARDS)).toEqual(["Basketball", "Soccer", "WNBA"])
  })
})

describe("profile sports are UPPER CASE on Panini (live 2026-10-26: spinotron's CSV said FOOTBALL)", () => {
  const profileCards = [
    card({ sku: "p1", sport: "WOMENS BASKETBALL" }),
    card({ sku: "p2", sport: "FOOTBALL" }),
    card({ sku: "p3", sport: "Football" }),
    card({ sku: "p4", sport: "WWE" }),
  ]
  it("one label per sport whatever its case — the WNBA filter finds the upper-case profile card", () => {
    expect(paniniCardSports(profileCards)).toEqual(["Football", "WNBA", "WWE"])
    expect(ids(filterSortPaniniCards(profileCards, { ...EMPTY_PANINI_CARD_FILTER, sport: "WNBA" }, "fmv_desc"))).toBe("p1")
    expect(ids(filterSortPaniniCards(profileCards, { ...EMPTY_PANINI_CARD_FILTER, sport: "Football" }, "player_asc"))).toBe("p2p3")
  })
  it("the CSV carries the label, never Panini's upper-case value", () => {
    const csv = buildPaniniCollectionCsv(profileCards)
    expect(csv).not.toMatch(/"FOOTBALL"|"WOMENS BASKETBALL"/)
    expect(csv).toContain('"WNBA"')
  })
})

describe("buildPaniniCollectionCsv", () => {
  const csv = buildPaniniCollectionCsv(filterSortPaniniCards(CARDS, EMPTY_PANINI_CARD_FILTER, "fmv_desc"))
  const lines = csv.split("\n")
  it("header contract is stable and never carries an FMV confidence column", () => {
    expect(lines[0]).toBe(PANINI_COLLECTION_CSV_HEADERS.map((h) => `"${h}"`).join(","))
    expect(lines[0]).not.toMatch(/confidence/i)
  })
  it("an unpriced, uncatalogued card exports an EMPTY FMV cell and no edition link — never 0", () => {
    const clark = lines.find((l) => l.startsWith('"Caitlin Clark"'))!
    expect(clark).toContain('"WNBA"')
    expect(clark).not.toMatch(/"0(\.00)?"/)
    expect(clark).not.toContain("/edition/")
  })
  it("a stale ask on an unlisted card is not exported as a listed price", () => {
    const haaland = lines.find((l) => l.startsWith('"Erling Haaland"'))!
    expect(haaland).not.toContain('"7.00"')
  })
  it("a priced card carries its FMV, listed price, special flag and edition URL", () => {
    expect(lines[1]).toBe('"Lionel Messi","Gold","Soccer","1","10","#1","650.00","900.00","","","https://www.rippackscity.com/panini-blockchain/edition/packcard-1"')
  })
})
