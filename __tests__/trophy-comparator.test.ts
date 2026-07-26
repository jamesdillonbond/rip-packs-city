import { describe, it, expect } from "vitest"
import { trophyComparator, tierRank, TROPHY_TIER_RANK, TROPHY_SORTS } from "@/lib/trophy-comparator"

type M = {
  tier?: string | null
  fmv?: number | null
  serial_number?: number | null
  player_name?: string | null
  set_name?: string | null
  series?: number | null
}
const sortBy = (rows: M[], key: Parameters<typeof trophyComparator>[0]) =>
  [...rows].sort(trophyComparator<M>(key))

describe("tierRank — cross-collection rarity", () => {
  it("ranks the full enum, ULTIMATE highest", () => {
    expect(tierRank("ULTIMATE")).toBe(9)
    expect(tierRank("legendary")).toBe(8) // case-insensitive
    expect(tierRank("CHALLENGER")).toBeGreaterThan(tierRank("CONTENDER"))
    expect(tierRank("COMMON")).toBe(1)
  })
  it("unknown/null → 0 (sorts lowest)", () => {
    expect(tierRank(null)).toBe(0)
    expect(tierRank("MYSTERY")).toBe(0)
  })
  it("covers cross-collection tiers Top-Shot-only maps omit", () => {
    for (const t of ["CHAMPION", "UNCOMMON", "CHALLENGER", "CONTENDER"]) {
      expect(TROPHY_TIER_RANK[t]).toBeGreaterThan(0)
    }
  })
})

describe("trophyComparator", () => {
  it("rarity: highest tier first, fmv tie-break", () => {
    const out = sortBy(
      [
        { tier: "COMMON", fmv: 5 },
        { tier: "ULTIMATE", fmv: 100 },
        { tier: "RARE", fmv: 50 },
        { tier: "RARE", fmv: 80 }, // same tier, higher fmv wins tie-break
      ],
      "rarity",
    )
    expect(out.map((m) => m.tier)).toEqual(["ULTIMATE", "RARE", "RARE", "COMMON"])
    expect(out[1].fmv).toBe(80) // fmv tie-break within RARE
  })

  it("fmv: highest value first; missing fmv sinks to the bottom (not the top)", () => {
    const out = sortBy([{ fmv: 10 }, { fmv: null }, { fmv: 999 }], "fmv")
    expect(out.map((m) => m.fmv)).toEqual([999, 10, null])
  })

  it("serial: LOWEST serial first; missing serial sinks", () => {
    const out = sortBy([{ serial_number: 50 }, { serial_number: 1 }, { serial_number: null }], "serial")
    expect(out.map((m) => m.serial_number)).toEqual([1, 50, null])
  })

  it("player: A→Z; missing name sorts last", () => {
    const out = sortBy([{ player_name: "Zeke" }, { player_name: "Al" }, { player_name: null }], "player")
    expect(out.map((m) => m.player_name)).toEqual(["Al", "Zeke", null])
  })

  it("set: by set name, then series, then serial", () => {
    const out = sortBy(
      [
        { set_name: "B", series: 2, serial_number: 5 },
        { set_name: "A", series: 4, serial_number: 9 },
        { set_name: "A", series: 4, serial_number: 2 }, // same set+series, lower serial first
      ],
      "set",
    )
    expect(out.map((m) => `${m.set_name}${m.series}#${m.serial_number}`)).toEqual(["A4#2", "A4#9", "B2#5"])
  })
})

describe("TROPHY_SORTS", () => {
  it("exposes the five sort options in order", () => {
    expect(TROPHY_SORTS.map((s) => s.key)).toEqual(["rarity", "fmv", "serial", "player", "set"])
  })
})
