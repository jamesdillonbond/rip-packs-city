// #259 (2026-11-15): 90 Candy editions merged DIFFERENT cards (42,592 holdings) plus 9 date-bug buckets.
// The listed key keeps its MAJORITY card (the edition's stored circulation); a card of another known edition
// size gets `<key>-n<size>`; an unknown size, an unlisted key and a date-bug bucket are left as they are.
import { describe, expect, it } from "vitest"
import { CANDY_SPLIT_EDITION_KEYS, isSplitEditionKey, splitEditionKey } from "@/lib/chains/solana/candy-split-editions"

const HELMET = "c:2024-mlb-all-star-commemorative-helmet:2024-mlb-allstar"

describe("splitEditionKey", () => {
  it("the majority size keeps the key; another size gets its own edition", () => {
    expect(splitEditionKey(HELMET, 797)).toBe(HELMET)
    expect(splitEditionKey(HELMET, 1454)).toBe(`${HELMET}-n1454`)
    expect(splitEditionKey(HELMET, 1443)).toBe(`${HELMET}-n1443`)
  })
  it("an unknown size never guesses: the card stays", () => {
    expect(splitEditionKey(HELMET, null)).toBe(HELMET)
    expect(splitEditionKey(HELMET, 0)).toBe(HELMET)
  })
  it("an unlisted key is never touched", () => {
    expect(splitEditionKey("c:2022-leadoff-icons:phil-bickford-core", 9999)).toBe("c:2022-leadoff-icons:phil-bickford-core")
  })
  it("a date-bug bucket (null) adds no suffix — the fixed baseName already moves its cards", () => {
    expect(CANDY_SPLIT_EDITION_KEYS["c:2022-tickets:seattle-mariners-at-houston-astros-10"]).toBeNull()
    expect(splitEditionKey("c:2022-tickets:seattle-mariners-at-houston-astros-10", 500)).toBe("c:2022-tickets:seattle-mariners-at-houston-astros-10")
  })
})

describe("the registry", () => {
  const entries = Object.entries(CANDY_SPLIT_EDITION_KEYS)
  it("holds the 97 measured keys, all prefixed Candy keys, each size a positive integer or null", () => {
    expect(entries).toHaveLength(97)
    for (const [k, v] of entries) {
      expect(k.startsWith("c:")).toBe(true)
      expect(v === null || (Number.isInteger(v) && v > 0)).toBe(true)
    }
  })
  it("isSplitEditionKey is an own-key lookup (no prototype keys, no empty input)", () => {
    expect(isSplitEditionKey(HELMET)).toBe(true)
    expect(isSplitEditionKey("toString")).toBe(false)
    expect(isSplitEditionKey("")).toBe(false)
    expect(isSplitEditionKey(null)).toBe(false)
  })
})
