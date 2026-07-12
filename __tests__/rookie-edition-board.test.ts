import { describe, it, expect } from "vitest"
import { normalizeRow, PARALLEL_ORDER } from "@/lib/rookie-edition-board"

// Rookie Edition Board row normalizer + parallel display-order map (skipping the
// DB fetch). Locks: numeric coercion (empty/invalid/null → null), string
// passthrough with null fallback, strict boolean coercion of has_full_economics
// (only literal true counts), and the Standard-first parallel ordering.

describe("normalizeRow", () => {
  it("coerces numeric strings and passes strings through", () => {
    const row = normalizeRow({
      player_name: "Cooper Flagg",
      set_name: "Base Set",
      series_number: "8",
      tier: "COMMON",
      parallel_id: "19",
      circulation_count: "1000",
      fmv_usd: "42.5",
      external_id: "233:8121::19",
      has_full_economics: false,
    })
    expect(row.player_name).toBe("Cooper Flagg")
    expect(row.series_number).toBe(8)
    expect(row.parallel_id).toBe(19)
    expect(row.circulation_count).toBe(1000)
    expect(row.fmv_usd).toBe(42.5)
    expect(row.external_id).toBe("233:8121::19")
  })

  it("coerces empty / invalid / missing numerics to null", () => {
    const row = normalizeRow({ fmv_usd: "", circulation_count: "abc" })
    expect(row.fmv_usd).toBeNull()
    expect(row.circulation_count).toBeNull()
    expect(row.burned).toBeNull() // absent key
  })

  it("defaults missing string fields to null", () => {
    const row = normalizeRow({})
    expect(row.player_name).toBeNull()
    expect(row.tier).toBeNull()
    expect(row.thumbnail_url).toBeNull()
  })

  it("has_full_economics is strictly boolean — only literal true", () => {
    expect(normalizeRow({ has_full_economics: true }).has_full_economics).toBe(true)
    expect(normalizeRow({ has_full_economics: "true" }).has_full_economics).toBe(false)
    expect(normalizeRow({ has_full_economics: 1 }).has_full_economics).toBe(false)
    expect(normalizeRow({}).has_full_economics).toBe(false)
  })
})

describe("PARALLEL_ORDER", () => {
  it("orders Standard(0) first, then ascending rarity by subedition id", () => {
    expect(PARALLEL_ORDER[0]).toBe(0)
    expect(PARALLEL_ORDER[17]).toBe(1)
    expect(PARALLEL_ORDER[22]).toBe(6)
    // strictly increasing across the known subedition ids
    const ids = [0, 17, 18, 19, 20, 21, 22]
    const ranks = ids.map((i) => PARALLEL_ORDER[i])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})
