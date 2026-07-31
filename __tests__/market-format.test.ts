import { describe, it, expect } from "vitest"
import { parseList, fmtDiscount, resolveListingUrl, collectDistinct, fmtUsd, tierColor, ownLockLabel, TIER_COLORS } from "@/lib/market-format"

describe("parseList", () => {
  it("splits, trims, drops empties", () => {
    expect(parseList("a, b ,,c")).toEqual(["a", "b", "c"])
  })
  it("null/empty → []", () => {
    expect(parseList(null)).toEqual([])
    expect(parseList("")).toEqual([])
  })
})

describe("fmtDiscount — deal-badge bands", () => {
  it("green tiers at >=25 and >=10", () => {
    expect(fmtDiscount(30)).toEqual({ text: "-30%", color: "#22C55E" })
    expect(fmtDiscount(15)).toEqual({ text: "-15%", color: "#84CC16" })
  })
  it("small positive is muted", () => {
    expect(fmtDiscount(5).text).toBe("-5%")
    expect(fmtDiscount(5).color).toBe("var(--rpc-text-secondary)")
  })
  it("NEGATIVE discount is a PREMIUM shown +N% in red", () => {
    expect(fmtDiscount(-8)).toEqual({ text: "+8%", color: "#EF4444" })
  })
  it("exactly 0 → neutral; null → em dash", () => {
    expect(fmtDiscount(0)).toEqual({ text: "0%", color: "var(--rpc-text-muted)" })
    expect(fmtDiscount(null).text).toBe("—")
  })
})

describe("resolveListingUrl — dead-link rejection", () => {
  const momentUrl = (id: string) => `/moment/${id}`
  it("returns a live buyUrl", () => {
    expect(resolveListingUrl({ buyUrl: "https://shop.example/x", flowId: "9" }, momentUrl)).toBe(
      "https://shop.example/x",
    )
  })
  it("rejects Flowty / editionFlowID= / listings/p2p and falls back to the moment page", () => {
    expect(resolveListingUrl({ buyUrl: "https://flowty.io/l/1", flowId: "9" }, momentUrl)).toBe("/moment/9")
    expect(resolveListingUrl({ buyUrl: "https://x/listings/p2p?editionFlowID=5:12", flowId: "9" }, momentUrl)).toBe(
      "/moment/9",
    )
  })
  it("no live url and no flowId → null (no dead link, no fallback)", () => {
    expect(resolveListingUrl({ buyUrl: "https://flowty.io/l/1", flowId: null }, momentUrl)).toBeNull()
    expect(resolveListingUrl({ buyUrl: null, flowId: null }, momentUrl)).toBeNull()
  })
})

describe("collectDistinct", () => {
  it("distinct non-empty values, locale-sorted", () => {
    const rows = [{ t: "Guard" }, { t: "Center" }, { t: "Guard" }, { t: "" }, { t: null }]
    expect(collectDistinct(rows, (r) => r.t)).toEqual(["Center", "Guard"])
  })
  it("empty input → []", () => {
    expect(collectDistinct([], (r: { t: string }) => r.t)).toEqual([])
  })
})

describe("fmtUsd", () => {
  it("null / non-finite → em dash", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd(undefined)).toBe("—")
    expect(fmtUsd(NaN)).toBe("—")
    expect(fmtUsd(Infinity)).toBe("—")
  })
  it("under $1000 → 2dp", () => {
    expect(fmtUsd(0)).toBe("$0.00")
    expect(fmtUsd(12.5)).toBe("$12.50")
    expect(fmtUsd(999.99)).toBe("$999.99")
  })
  it(">= $1000 → whole dollars with separators", () => {
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(12345.67)).toBe("$12,346")
  })
})

describe("tierColor", () => {
  it("null tier → muted token", () => {
    expect(tierColor(null)).toBe("var(--rpc-text-muted)")
  })
  it("known tier → its token, case-insensitive", () => {
    expect(tierColor("legendary")).toBe("var(--tier-legendary)")
    expect(tierColor("ULTIMATE")).toBe("var(--tier-ultimate)")
    expect(tierColor("Challenger")).toBe("var(--tier-challenger)")
  })
  it("unknown tier → muted token", () => {
    expect(tierColor("mythic")).toBe("var(--rpc-text-muted)")
  })
  it("TIER_COLORS covers the Top Shot + UFC vocab", () => {
    for (const t of ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE", "CHALLENGER", "CONTENDER"]) {
      expect(TIER_COLORS[t]).toMatch(/^var\(--tier-/)
    }
  })
})

describe("ownLockLabel", () => {
  it("null / zero-owned → em dash", () => {
    expect(ownLockLabel(null)).toBe("—")
    expect(ownLockLabel(undefined)).toBe("—")
    expect(ownLockLabel({ owned: 0, locked: 0 })).toBe("—")
  })
  it("owned>0 → 'owned / locked'", () => {
    expect(ownLockLabel({ owned: 5, locked: 2 })).toBe("5 / 2")
    expect(ownLockLabel({ owned: 3, locked: 0 })).toBe("3 / 0")
  })
})
