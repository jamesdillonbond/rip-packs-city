import { describe, it, expect } from "vitest"
import { formatCurrency, formatCount, humanizeLabel, dedupeLabelParts, metaField, joinMetaParts } from "@/lib/format"
import { borderCosmetic, bannerCosmetic } from "@/lib/cosmetics"

// Small shared utilities: money/count formatting, market scope key, edition
// aggregation, cosmetic lookups. Deterministic; pin the documented semantics.

describe("formatCurrency / formatCount", () => {
  it("distinguishes missing (—) from a real zero ($0)", () => {
    expect(formatCurrency(null)).toBe("—")
    expect(formatCurrency(undefined)).toBe("—")
    expect(formatCurrency(NaN)).toBe("—")
    expect(formatCurrency(0)).toBe("$0")
  })
  it("formats positive + negative with thousands", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50")
    expect(formatCurrency(-1234.5)).toBe("-$1,234.50")
  })
  it("formatCount groups and em-dashes missing", () => {
    expect(formatCount(12345)).toBe("12,345")
    expect(formatCount(null)).toBe("—")
  })
})

describe("cosmetics", () => {
  it("resolves known cosmetic values, null for unknown/nullish", () => {
    expect(borderCosmetic("flame")?.label).toBe("Flame")
    expect(borderCosmetic("nonexistent")).toBeNull()
    expect(borderCosmetic(null)).toBeNull()
    expect(bannerCosmetic("ripcity")?.label).toBe("Rip City")
    expect(bannerCosmetic(undefined)).toBeNull()
  })
})

describe("humanizeLabel", () => {
  // The live defect this exists for: the Golazos pack page rendered the literal
  // "In_season_premium" because CSS `text-transform: capitalize` does not treat
  // an underscore as a word boundary.
  it("turns snake_case enums into Title Case words", () => {
    expect(humanizeLabel("in_season_premium")).toBe("In Season Premium")
    expect(humanizeLabel("IN_SEASON_PREMIUM")).toBe("In Season Premium")
    expect(humanizeLabel("In_Season_Premium")).toBe("In Season Premium")
    expect(humanizeLabel("common")).toBe("Common")
  })
  it("collapses stray whitespace and trims", () => {
    expect(humanizeLabel("  chance   hit ")).toBe("Chance Hit")
    expect(humanizeLabel("a_b__c")).toBe("A B C")
  })
  it("leaves hyphens intact (they appear inside real names/slugs)", () => {
    expect(humanizeLabel("pack-sniper")).toBe("Pack-sniper")
  })
  it("returns an empty string for nullish/blank input", () => {
    expect(humanizeLabel(null)).toBe("")
    expect(humanizeLabel(undefined)).toBe("")
    expect(humanizeLabel("   ")).toBe("")
    expect(humanizeLabel("___")).toBe("")
  })
})

describe("dedupeLabelParts", () => {
  // Live defect: pin GEN-DPIN-SIMB-S0 has set_name "Walt Disney Animation
  // Studios • Disney Genesis " and franchises[0] "Walt Disney Animation
  // Studios", so set · franchise · series printed the studio twice.
  it("drops a part already contained in an earlier part", () => {
    expect(
      dedupeLabelParts(["Walt Disney Animation Studios • Disney Genesis ", "Walt Disney Animation Studios", "2023"]),
    ).toEqual(["Walt Disney Animation Studios • Disney Genesis", "2023"])
  })
  it("drops exact repeats case-insensitively, first occurrence wins", () => {
    expect(dedupeLabelParts(["LED MARQUEE", "LED MARQUEE"])).toEqual(["LED MARQUEE"])
    expect(dedupeLabelParts(["Led Marquee", "LED MARQUEE", "Gold"])).toEqual(["Led Marquee", "Gold"])
  })
  it("keeps order and skips blank/nullish parts", () => {
    expect(dedupeLabelParts(["A Set", null, "", undefined, "  ", "Series 3"])).toEqual(["A Set", "Series 3"])
  })
  it("does not let a long part swallow a short unrelated token", () => {
    // "S1" is < 4 normalised chars, so only an exact match removes it.
    expect(dedupeLabelParts(["Genesis Series 1", "S1"])).toEqual(["Genesis Series 1", "S1"])
  })
  it("keeps a longer part that merely contains an earlier shorter one", () => {
    expect(dedupeLabelParts(["Disney Genesis", "Disney Genesis Deluxe"])).toEqual([
      "Disney Genesis",
      "Disney Genesis Deluxe",
    ])
  })
})

// Metadata-safe field reads. Regression cover for the 2026-07-25 soft-data-noise
// bug: pinnacle_catalog.set_name = "Walt Disney Animation Studios • Disney
// Genesis " (trailing space) rendered the pin meta description as
// "…Disney Genesis , Genesis variant" — the stray space escaped ahead of the
// separator and landed in description + og:description + twitter:description.
describe("metaField", () => {
  it("trims the live trailing-space catalog value", () => {
    expect(metaField("Walt Disney Animation Studios • Disney Genesis ")).toBe(
      "Walt Disney Animation Studios • Disney Genesis",
    )
  })
  it("treats whitespace-only as ABSENT so a caller's ?? fallback fires", () => {
    expect(metaField("")).toBeNull()
    expect(metaField("   ")).toBeNull()
    expect(metaField("\n\t ")).toBeNull()
  })
  it("reports non-strings as absent rather than coercing them", () => {
    expect(metaField(null)).toBeNull()
    expect(metaField(undefined)).toBeNull()
    expect(metaField(42)).toBeNull()
    expect(metaField({})).toBeNull()
  })
  it("passes a clean value through untouched", () => {
    expect(metaField("Simba & Rafiki")).toBe("Simba & Rafiki")
  })
})

describe("joinMetaParts", () => {
  it("drops the dangling separator when a trailing part is absent", () => {
    // The pre-fix Pinnacle title was `${char} · ${variant ?? ""}` -> "Simba · ".
    expect(joinMetaParts(["Simba", null], " · ")).toBe("Simba")
    expect(joinMetaParts(["Simba", ""], " · ")).toBe("Simba")
  })
  it("collapses the double space a middle ?? \"\" used to leave", () => {
    // The pre-fix moment description was `for ${player} ${setName}` -> "for Simba  ".
    expect(joinMetaParts(["Simba", null], " ")).toBe("Simba")
    expect(joinMetaParts(["Simba", undefined, "Base Set"], " ")).toBe("Simba Base Set")
  })
  it("trims each part before joining", () => {
    expect(joinMetaParts([" Disney Genesis ", " Genesis variant "], ", ")).toBe(
      "Disney Genesis, Genesis variant",
    )
  })
  it("returns an empty string when nothing survives", () => {
    expect(joinMetaParts([null, undefined, "  "], " · ")).toBe("")
  })
  it("keeps input order and does NOT dedupe (that is dedupeLabelParts' job)", () => {
    expect(joinMetaParts(["Gold", "Gold"], " · ")).toBe("Gold · Gold")
  })
})
