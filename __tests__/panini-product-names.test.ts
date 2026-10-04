import { describe, it, expect } from "vitest"
import { parseProductNameObservations, decideProductNames } from "@/lib/chains/panini/product-names"
import { tallyCollectionNames, nameTallyRows, paniniIngestUrl } from "../scripts/panini-collector-walk.mjs"

// 2026-10-04: 135 of 137 Panini products had no name. The collector walk reads a profile one
// collection (= product) at a time, so each card read inside a collection is a (set id, name) pair.

describe("product names: the decision", () => {
  it("names a set id when its top name has >= 3 cards and >= 80% of them", () => {
    const { named, ambiguous } = decideProductNames([
      { set_id: 1959, name: "2021-22 Panini NFT Prizm Basketball", n: 8 },
      { set_id: 1959, name: "Stray", n: 2 }, // 80% exactly -> named
    ])
    expect(named).toEqual([{ set_id: 1959, name: "2021-22 Panini NFT Prizm Basketball", n: 8, share: 0.8 }])
    expect(ambiguous).toEqual([])
  })

  it("leaves a split or thin set id unnamed (no-change controls)", () => {
    const { named, ambiguous } = decideProductNames([
      { set_id: 1, name: "A", n: 7 }, { set_id: 1, name: "B", n: 3 }, // 70%
      { set_id: 2, name: "C", n: 2 }, // too few cards
    ])
    expect(named).toEqual([])
    expect(ambiguous).toEqual([1, 2])
  })

  it("sums the same name across collectors before deciding", () => {
    const { named } = decideProductNames([
      { set_id: 5, name: "P", n: 1 }, { set_id: 5, name: "P", n: 1 }, { set_id: 5, name: "P", n: 1 },
    ])
    expect(named.map((d) => [d.set_id, d.name, d.n])).toEqual([[5, "P", 3]])
  })

  it("drops malformed rows rather than half-reading them", () => {
    expect(parseProductNameObservations([
      { set_id: 1, name: " X ", n: 2 }, { set_id: 0, name: "Y", n: 1 }, { set_id: 2, name: "", n: 1 },
      { set_id: 3, name: "Z", n: 1.5 }, null, "junk",
    ])).toEqual([{ set_id: 1, name: "X", n: 2 }])
    expect(parseProductNameObservations({})).toEqual([])
  })
})

describe("product names: the collector walk's tally", () => {
  it("counts each card read inside a collection under that collection's name, by set id", () => {
    const tally = new Map()
    tallyCollectionNames(tally, [
      { psku: "packcard-1959_1_2_3" }, { psku: "packcard-1959_4_5_6" }, { psku: "packcard-2420_1_1_1" }, { psku: null },
    ], "2021-22 Panini NFT Prizm Basketball")
    tallyCollectionNames(tally, [{ psku: "packcard-1959_7_8_9" }], "2021-22 Panini NFT Prizm Basketball")
    expect(nameTallyRows(tally)).toEqual([
      { set_id: 1959, name: "2021-22 Panini NFT Prizm Basketball", n: 3 },
      { set_id: 2420, name: "2021-22 Panini NFT Prizm Basketball", n: 1 },
    ])
    expect(nameTallyRows(tallyCollectionNames(new Map(), [{ psku: "packcard-1_2_3_4" }], "  "))).toEqual([])
  })

  it("posts to the ingest route beside its own receiver, never elsewhere", () => {
    expect(paniniIngestUrl("https://www.rippackscity.com/api/cron/panini-collector-walk")).toBe("https://www.rippackscity.com/api/cron/panini-ingest")
    expect(paniniIngestUrl("https://evil.example/x")).toBeNull()
    expect(paniniIngestUrl(undefined)).toBeNull()
  })
})
