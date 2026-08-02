import { describe, it, expect } from "vitest"
import {
  type TrophyMomentLike,
  TIER_ORDER,
  normalizeTier,
  tierColor,
  fmtUsd,
  displayName,
  tierRank,
  presentTiers,
  filterSortMoments,
} from "@/lib/trophy-picker-format"

// Pins the pure tier/format/filter-sort logic lifted out of
// components/profile/TrophyPickerModal.tsx (invisible to the coverage ratchet).
// A regression here mis-labels FMV, mis-ranks tiers, or breaks the trophy
// picker's filter/sort/search.

function m(partial: Partial<TrophyMomentLike> & { moment_id: string }): TrophyMomentLike {
  return partial
}

describe("normalizeTier", () => {
  it("returns null for null/undefined/empty", () => {
    expect(normalizeTier(null)).toBeNull()
    expect(normalizeTier(undefined)).toBeNull()
    expect(normalizeTier("")).toBeNull()
  })
  it("matches canonical tiers case-insensitively", () => {
    expect(normalizeTier("ULTIMATE")).toBe("ULTIMATE")
    expect(normalizeTier("legendary")).toBe("LEGENDARY")
    expect(normalizeTier("Rare")).toBe("RARE")
    expect(normalizeTier("fandom")).toBe("FANDOM")
    expect(normalizeTier("UNCOMMON")).toBe("UNCOMMON")
    expect(normalizeTier("common")).toBe("COMMON")
  })
  it("matches when the tier is embedded in a longer label", () => {
    expect(normalizeTier("Series 4 Legendary")).toBe("LEGENDARY")
    expect(normalizeTier("super rare parallel")).toBe("RARE")
  })
  it("returns null for an unrecognized tier", () => {
    expect(normalizeTier("MYTHIC")).toBeNull()
  })
})

describe("tierColor", () => {
  it("maps each tier to its design token (moved off hex 2026-08-01)", () => {
    expect(tierColor("ULTIMATE")).toBe("var(--tier-ultimate)")
    expect(tierColor("LEGENDARY")).toBe("var(--tier-legendary)")
    expect(tierColor("RARE")).toBe("var(--tier-rare)")
    expect(tierColor("FANDOM")).toBe("var(--tier-fandom)")
    expect(tierColor("UNCOMMON")).toBe("var(--tier-uncommon)")
    expect(tierColor("COMMON")).toBe("var(--tier-common)")
  })
  it("falls back to the neutral token for null", () => {
    expect(tierColor(null)).toBe("var(--rpc-text-muted)")
  })
  it("never returns a raw hex literal (design-system rule)", () => {
    for (const t of [null, "ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "UNCOMMON", "COMMON"] as const) {
      expect(tierColor(t)).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    }
  })
})

describe("fmtUsd", () => {
  it("renders em-dash for null/undefined", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
  })
  it("renders $0 for a falsy zero", () => {
    expect(fmtUsd(0)).toBe("$0")
  })
  it("keeps two decimals under $1,000", () => {
    expect(fmtUsd(12.5)).toBe("$12.50")
    expect(fmtUsd(999.99)).toBe("$999.99")
  })
  it("rounds and comma-groups $1,000+", () => {
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(1234.56)).toBe("$1,235")
    expect(fmtUsd(1000000)).toBe("$1,000,000")
  })
})

describe("displayName", () => {
  it("prefers player_name, then character, then edition, then id", () => {
    expect(displayName(m({ moment_id: "x", player_name: "LeBron" }))).toBe("LeBron")
    expect(displayName(m({ moment_id: "x", character_name: "Mickey" }))).toBe("Mickey")
    expect(displayName(m({ moment_id: "x", edition_name: "Rare Base" }))).toBe("Rare Base")
    expect(displayName(m({ moment_id: "abc123" }))).toBe("abc123")
  })
  it("skips empty-string names in the fallback chain", () => {
    expect(displayName(m({ moment_id: "id", player_name: "", character_name: "Char" }))).toBe("Char")
  })
})

describe("tierRank", () => {
  it("ranks rarest first (index in TIER_ORDER)", () => {
    expect(tierRank("ULTIMATE")).toBe(0)
    expect(tierRank("COMMON")).toBe(TIER_ORDER.length - 1)
  })
  it("sinks null to the bottom", () => {
    expect(tierRank(null)).toBe(99)
  })
  it("orders ultimate < legendary < ... < common", () => {
    const ranks = TIER_ORDER.map(tierRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe("presentTiers", () => {
  it("returns [] for null/undefined", () => {
    expect(presentTiers(null)).toEqual([])
    expect(presentTiers(undefined)).toEqual([])
  })
  it("returns the present tiers in rarity order, deduped, ignoring unknowns", () => {
    const moments = [
      m({ moment_id: "1", tier: "common" }),
      m({ moment_id: "2", tier: "ULTIMATE" }),
      m({ moment_id: "3", tier: "rare" }),
      m({ moment_id: "4", tier: "common" }),
      m({ moment_id: "5", tier: "mythic" }),
      m({ moment_id: "6", tier: null }),
    ]
    expect(presentTiers(moments)).toEqual(["ULTIMATE", "RARE", "COMMON"])
  })
})

describe("filterSortMoments", () => {
  const moments: TrophyMomentLike[] = [
    { moment_id: "1", player_name: "Curry", set_name: "Base", team_name: "Warriors", tier: "rare", serial_number: 50, fmv_usd: 100 },
    { moment_id: "2", player_name: "Durant", set_name: "Metallic", team_name: "Suns", tier: "legendary", serial_number: 5, fmv_usd: 500 },
    { moment_id: "3", player_name: "Jokic", set_name: "Base", team_name: "Nuggets", tier: "common", serial_number: 5, fmv_usd: 20 },
    { moment_id: "4", character_name: "Elsa", set_name: "Frozen", tier: null, serial_number: null, fmv_usd: null },
  ]

  it("returns [] for null moments", () => {
    expect(filterSortMoments(null, "fmv_desc", "ALL", "")).toEqual([])
  })

  it("does not mutate the input array", () => {
    const copy = moments.slice()
    filterSortMoments(moments, "fmv_desc", "ALL", "")
    expect(moments).toEqual(copy)
  })

  it("fmv_desc sorts by FMV descending, treating null as 0", () => {
    const ids = filterSortMoments(moments, "fmv_desc", "ALL", "").map((x) => x.moment_id)
    expect(ids).toEqual(["2", "1", "3", "4"])
  })

  it("serial_asc sorts by serial ascending with FMV-desc tie-break, nulls last", () => {
    const ids = filterSortMoments(moments, "serial_asc", "ALL", "").map((x) => x.moment_id)
    // #5 tie between Durant(500) and Jokic(20) → Durant first; #50 next; null serial last
    expect(ids).toEqual(["2", "3", "1", "4"])
  })

  it("tier_rank sorts by rarity with FMV-desc tie-break", () => {
    const ids = filterSortMoments(moments, "tier_rank", "ALL", "").map((x) => x.moment_id)
    // legendary(2) < rare(1) < common(3) < null-tier(4, rank 99)
    expect(ids).toEqual(["2", "1", "3", "4"])
  })

  it("tier filter keeps only the matching normalized tier", () => {
    const res = filterSortMoments(moments, "fmv_desc", "COMMON", "")
    expect(res.map((x) => x.moment_id)).toEqual(["3"])
  })

  it("query matches across name, set, team, and character (case-insensitive)", () => {
    expect(filterSortMoments(moments, "fmv_desc", "ALL", "curry").map((x) => x.moment_id)).toEqual(["1"])
    expect(filterSortMoments(moments, "fmv_desc", "ALL", "base").map((x) => x.moment_id)).toEqual(["1", "3"])
    expect(filterSortMoments(moments, "fmv_desc", "ALL", "SUNS").map((x) => x.moment_id)).toEqual(["2"])
    expect(filterSortMoments(moments, "fmv_desc", "ALL", "elsa").map((x) => x.moment_id)).toEqual(["4"])
  })

  it("trims whitespace-only queries to match everything", () => {
    expect(filterSortMoments(moments, "fmv_desc", "ALL", "   ")).toHaveLength(4)
  })

  it("combines tier filter and query", () => {
    const res = filterSortMoments(moments, "fmv_desc", "RARE", "warriors")
    expect(res.map((x) => x.moment_id)).toEqual(["1"])
    expect(filterSortMoments(moments, "fmv_desc", "RARE", "nuggets")).toHaveLength(0)
  })
})
