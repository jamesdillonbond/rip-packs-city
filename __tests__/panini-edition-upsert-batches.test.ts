import { describe, it, expect } from "vitest"
import { editionUpsertBatches } from "@/lib/chains/panini/edition-upsert-batches"
import { toEditionRow } from "@/lib/chains/panini/ingest-normalize"

const NOW = "2026-11-22T22:00:00.000Z"

describe("Panini edition upserts never erase a stored team (2026-11-22)", () => {
  it("toEditionRow leaves `nation` OUT of the row when the payload carries no team — never null", () => {
    // The per-card API (getCardMarketStats) has no team; only the marketplace grid does.
    const walked = toEditionRow({ psku: "packcard-2478_1_1_1", athlete: "Sophia Wilson", cardset: "Base" }, NOW)
    expect("nation" in walked).toBe(false)
    const blank = toEditionRow({ psku: "packcard-2478_1_1_1", athlete: "A", cardset: "Base", __nation: "  " }, NOW)
    expect("nation" in blank).toBe(false)
  })

  it("toEditionRow carries the grid's team when it has one", () => {
    const seen = toEditionRow({ psku: "packcard-2478_1_1_1", athlete: "Sophia Wilson", cardset: "Base", __nation: "Portland Thorns FC" }, NOW)
    expect(seen.nation).toBe("Portland Thorns FC")
  })

  it("no batch mixes rows with and without `nation`, so no batch's column list can NULL a team", () => {
    const rows = [
      toEditionRow({ psku: "packcard-2478_1_1_1", athlete: "A", cardset: "Base", __nation: "Portland Thorns FC" }, NOW),
      toEditionRow({ psku: "packcard-2478_2_1_1", athlete: "B", cardset: "Base" }, NOW),
      toEditionRow({ psku: "packcard-2478_3_1_1", athlete: "C", cardset: "Base", __nation: "Bay FC" }, NOW),
      toEditionRow({ psku: "packcard-2478_4_1_1", athlete: "D", cardset: "Base" }, NOW),
    ]
    const batches = editionUpsertBatches(rows, 500)
    expect(batches.flat()).toHaveLength(4)
    for (const b of batches) {
      const withTeam = b.filter((r) => "nation" in r).length
      expect(withTeam === 0 || withTeam === b.length).toBe(true)
    }
  })

  it("chunks each shape at the batch size and keeps every row exactly once", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ external_id: `e${i}`, ...(i % 2 ? { nation: "T" } : {}) }))
    const batches = editionUpsertBatches(rows, 2)
    expect(batches.every((b) => b.length <= 2)).toBe(true)
    expect(batches.flat().map((r) => r.external_id).sort()).toEqual(rows.map((r) => r.external_id).sort())
  })
})
