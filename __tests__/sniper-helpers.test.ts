import { describe, it, expect } from "vitest"
import {
  isVerifiedDeal,
  resolveViewUrl,
  resolveDapperUrl,
  fmt,
  tierColor,
  allDayTierColor,
  resolveTierColor,
  holoClass,
  variantLabel,
  discountColor,
} from "@/lib/sniper/helpers"
import type { SniperDeal } from "@/lib/sniper/types"

// Pure display/label + outbound-URL helpers for the sniper page. isVerifiedDeal
// is the HIGH+MED "real bargain" gate; the URL resolvers must not mint dead
// Flowty links or wrong dapper deep-links.

const deal = (o: Partial<SniperDeal> = {}) => o as SniperDeal

describe("isVerifiedDeal", () => {
  it("true for HIGH/MEDIUM confidence not thin-clamped or ask-fallback", () => {
    expect(isVerifiedDeal(deal({ confidence: "high" }))).toBe(true)
    expect(isVerifiedDeal(deal({ confidence: "MEDIUM" }))).toBe(true)
  })
  it("false for low confidence, thin-clamp, or ask fallback", () => {
    expect(isVerifiedDeal(deal({ confidence: "low" }))).toBe(false)
    expect(isVerifiedDeal(deal({ confidence: "high", lowConfidenceFmv: true }))).toBe(false)
    expect(isVerifiedDeal(deal({ confidence: "high", confidenceSource: "ask_fallback" }))).toBe(false)
  })
})

describe("resolveViewUrl", () => {
  it("uses the deal's own live listing url when it is not a dead Flowty link", () => {
    expect(resolveViewUrl(deal({ buyUrl: "https://nbatopshot.com/moment/9" }), "nba-top-shot")).toBe(
      "https://nbatopshot.com/moment/9"
    )
  })
  it("falls back to the native marketplace url for a Flowty link", () => {
    expect(resolveViewUrl(deal({ buyUrl: "https://flowty.io/x", momentId: "9" }), "nba-top-shot")).toBe(
      "https://nbatopshot.com/moment/9"
    )
  })
})

describe("resolveDapperUrl", () => {
  it("builds a dapper link for a numeric Top Shot moment id", () => {
    expect(resolveDapperUrl(deal({ source: "topshot", momentId: "999" }), "nba-top-shot")).toBe(
      "https://dapper.market/nba/moment/999"
    )
  })
  it("returns null for an edition-level key (non-numeric momentId)", () => {
    expect(resolveDapperUrl(deal({ source: "topshot", momentId: "73:2785" }), "nba-top-shot")).toBeNull()
  })
  it("AllDay uses flowId only when it differs from momentId", () => {
    expect(
      resolveDapperUrl(deal({ source: "allday", momentId: "ed1", flowId: "555" }), "nfl-all-day")
    ).toBe("https://dapper.market/nfl/moment/555")
    expect(
      resolveDapperUrl(deal({ source: "allday", momentId: "ed1", flowId: "ed1" }), "nfl-all-day")
    ).toBeNull()
  })
})

describe("formatting + color helpers", () => {
  it("fmt renders fixed decimals with grouping", () => {
    expect(fmt(1234.5)).toBe("1,234.50")
    expect(fmt(1234.5, 0)).toBe("1,235")
  })
  it("tierColor maps to a CSS var, unknown → common", () => {
    expect(tierColor("LEGENDARY")).toBe("var(--tier-legendary)")
    expect(tierColor("mystery")).toBe("var(--tier-common)")
  })
  it("allDayTierColor uses the AllDay palette", () => {
    expect(allDayTierColor("RARE")).toBe("#3B82F6")
    expect(allDayTierColor("nope")).toBe("#94A3B8")
  })
  it("resolveTierColor dispatches on isAllDay", () => {
    expect(resolveTierColor("RARE", true)).toBe("#3B82F6")
    expect(resolveTierColor("RARE", false)).toBe("var(--tier-rare)")
  })
  it("holoClass only for Rare/Legendary/Ultimate", () => {
    expect(holoClass("ULTIMATE")).toBe("rpc-holo-ultimate")
    expect(holoClass("COMMON")).toBe("")
  })
  it("variantLabel falls back to the raw variant", () => {
    expect(variantLabel("Totally Unknown Variant")).toBe("Totally Unknown Variant")
  })
  it("discountColor escalates styling by percent bucket", () => {
    expect(discountColor(60).color).toBeDefined() // >=50 bucket has a color
    expect(discountColor(1)).toEqual({ border: "1px solid var(--rpc-border)" }) // <5 plain
  })
})
