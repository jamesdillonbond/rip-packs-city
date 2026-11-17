import { describe, it, expect } from "vitest"
import { buildEditionSeedCandidate } from "@/lib/edition-market-seed"

// lib/edition-market-seed.ts builds a manual-seed market candidate, normalizing
// the set/parallel and deriving a scope-key alias so a hand-seeded edition keys
// to the same scope the live aggregator uses. Previously untested.

describe("buildEditionSeedCandidate", () => {
  it("produces a manual-seed candidate with null market values and a scope-key alias", () => {
    const c = buildEditionSeedCandidate({
      editionKey: "84:2892",
      setName: "Base Set",
      playerName: "Damian Lillard",
      parallel: "Standard",
    })
    expect(c.editionKey).toBe("84:2892")
    expect(c.playerName).toBe("Damian Lillard")
    expect(c.source).toBe("manual-seed")
    expect(c.lowAsk).toBeNull()
    expect(c.bestOffer).toBeNull()
    expect(c.lastSale).toBeNull()
    expect(Array.isArray(c.aliases)).toBe(true)
    expect(c.aliases.length).toBe(1)
    expect(typeof c.aliases[0]).toBe("string")
    expect(c.aliases[0].length).toBeGreaterThan(0)
  })

  it("falls back to subedition when no parallel is given", () => {
    const withSub = buildEditionSeedCandidate({ editionKey: "1:2", setName: "S", subedition: "Hexwave" })
    const withPar = buildEditionSeedCandidate({ editionKey: "1:2", setName: "S", parallel: "Hexwave" })
    // Same normalized parallel → same scope-key alias.
    expect(withSub.parallel).toBe(withPar.parallel)
    expect(withSub.aliases[0]).toBe(withPar.aliases[0])
  })

  it("coerces empty/missing set name to null", () => {
    const c = buildEditionSeedCandidate({ editionKey: "1:2" })
    expect(c.setName).toBeNull()
    expect(c.playerName).toBeNull()
  })

  it("is deterministic for identical input", () => {
    const input = { editionKey: "5:9", setName: "Set A", playerName: "P", parallel: "Standard" }
    expect(buildEditionSeedCandidate(input)).toEqual(buildEditionSeedCandidate(input))
  })
})
