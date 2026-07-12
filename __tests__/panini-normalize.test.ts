import { describe, it, expect } from "vitest"
import { parallelFamily, toEditionRow, PANINI_UUID } from "@/lib/chains/panini/normalize"

// Panini (Ethereum bridge) edition normalization — chain-prep. parallelFamily
// buckets the parallel into a family; toEditionRow builds the stable
// set:player:parallel external key that dedups editions.

describe("parallelFamily", () => {
  it("fotl-exclusive wins over everything", () => {
    expect(parallelFamily("Base Set", "Silver", true)).toBe("fotl_exclusive")
  })
  it("base sets bucket to 'base'", () => {
    expect(parallelFamily("Base Series 1", "Standard")).toBe("base")
  })
  it("silver/gold/black parallels are tiered inserts", () => {
    expect(parallelFamily("Insert", "Gold Prizm")).toBe("tiered_insert")
    expect(parallelFamily("Insert", "Black")).toBe("tiered_insert")
  })
  it("everything else is a non-tiered insert", () => {
    expect(parallelFamily("Insert", "Blue Wave")).toBe("non_tiered_insert")
  })
})

describe("toEditionRow", () => {
  const raw = (o: any) => o as any
  const NOW = "2026-07-12T00:00:00.000Z"

  it("builds the whitespace-collapsed set:player:parallel external id + panini identity", () => {
    const row = toEditionRow(
      raw({ id: "e1", set: "Prizm Insert", player: "Lionel Messi", parallel: "Gold", circulation: 3, mintCap: 100 }),
      NOW
    )
    expect(row.external_id).toBe("Prizm_Insert:Lionel_Messi:Gold")
    expect(row.collection_id).toBe(PANINI_UUID)
    expect(row.parallel_family).toBe("tiered_insert") // non-base set + gold → tiered
    expect(row.mint_cap).toBe(100)
    expect(row.pulled_count).toBe(3)
    expect(row.last_seen_at).toBe(NOW)
  })

  it("clamps pulled_count to >=0 and nulls a non-finite mint cap", () => {
    const row = toEditionRow(
      raw({ id: "e2", set: "Insert", player: "X", parallel: "Blue", circulation: -5, mintCap: NaN }),
      NOW
    )
    expect(row.pulled_count).toBe(0)
    expect(row.mint_cap).toBeNull()
  })

  it("marks fotl exclusives", () => {
    const row = toEditionRow(
      raw({ id: "e3", set: "Base", player: "Y", parallel: "Std", isFotlExclusive: true }),
      NOW
    )
    expect(row.is_fotl_exclusive).toBe(true)
    expect(row.parallel_family).toBe("fotl_exclusive")
  })
})
