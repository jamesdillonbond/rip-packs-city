import { describe, it, expect } from "vitest"
import {
  seriesDisplayLabel,
  seriesFilterLabel,
  seriesIntToSeason,
  formatAcquiredAt,
  compareText,
  compareNumber,
  getParallel,
  getSerial,
  getMint,
  getTraits,
  getLocked,
  proxyTopShotThumb,
  getThumbnailUrl,
  getBestAsk,
  getPrimarySerialBadge,
  debugReasonLabel,
  confidenceLabel,
  fmvDisplay,
} from "@/lib/collection/helpers"
import type { MomentRow } from "@/lib/collection/types"

// Pure display/derivation helpers behind the wallet-collection viewer. Broad,
// deterministic, and easy to regress in a refactor (they were extracted
// "verbatim" once already) — pin the series labels, thumbnail proxying, best-ask
// selection, and FMV/confidence formatting.

const row = (o: Partial<MomentRow> = {}) => o as MomentRow

describe("series label helpers (on-chain int → display)", () => {
  it("seriesDisplayLabel uses the fallback map, then raw", () => {
    expect(seriesDisplayLabel("0")).toBe("S1 · 2019-20")
    expect(seriesDisplayLabel("8")).toBe("25-26 · 2025-26")
    expect(seriesDisplayLabel("weird")).toBe("weird")
    expect(seriesDisplayLabel(null)).toBe("—")
  })

  it("seriesFilterLabel maps to 'Series N' fallbacks", () => {
    expect(seriesFilterLabel("0")).toBe("Series 1")
    expect(seriesFilterLabel("3")).toBe("Summer 2021")
    expect(seriesFilterLabel(null)).toBe("—")
  })

  it("seriesIntToSeason maps ints to seasons and passes through YYYY / YYYY-YY", () => {
    expect(seriesIntToSeason("0")).toBe("2019-20")
    expect(seriesIntToSeason("2024-25")).toBe("2024-25")
    expect(seriesIntToSeason("2021")).toBe("2021")
    expect(seriesIntToSeason(null)).toBe("")
  })

  it("prefers a provided seriesMap over the fallback", () => {
    const map = new Map([[8, { display_label: "S8", season: "25-26" } as any]])
    expect(seriesDisplayLabel("8", map)).toBe("S8 · 25-26")
    expect(seriesFilterLabel("8", map)).toBe("S8")
  })
})

describe("formatAcquiredAt", () => {
  it("returns em-dash for nullish / invalid dates", () => {
    expect(formatAcquiredAt(null)).toBe("—")
    expect(formatAcquiredAt(undefined)).toBe("—")
    expect(formatAcquiredAt("not-a-date")).toBe("—")
  })

  it("formats a valid ISO timestamp (contains the year, not em-dash)", () => {
    const out = formatAcquiredAt("2026-07-04T12:00:00Z")
    expect(out).not.toBe("—")
    expect(out).toMatch(/2026/)
  })
})

describe("comparators", () => {
  it("compareText sorts nullish as empty string", () => {
    expect(compareText("a", "b")).toBeLessThan(0)
    expect(compareText(null, "b")).toBeLessThan(0)
    expect(compareText(null, null)).toBe(0)
  })

  it("compareNumber sorts nullish as -Infinity", () => {
    expect(compareNumber(2, 1)).toBeGreaterThan(0)
    expect(compareNumber(null, 1)).toBe(-Infinity)
  })
})

describe("row field accessors (multi-shape fallbacks)", () => {
  it("getParallel normalizes empty to 'Base' and reads parallel|subedition", () => {
    expect(getParallel(row({}))).toBe("Base")
    expect(getParallel(row({ subedition: "Diced" }))).toBe("Diced")
    expect(getParallel(row({ parallel: "Hexwave" }))).toBe("Hexwave")
  })

  it("getSerial / getMint read either field name", () => {
    expect(getSerial(row({ serial: 7 }))).toBe(7)
    expect(getSerial(row({ serialNumber: 9 }))).toBe(9)
    expect(getSerial(row({}))).toBeNull()
    expect(getMint(row({ mintSize: 100 }))).toBe(100)
    expect(getMint(row({ mintCount: 250 }))).toBe(250)
  })

  it("getTraits defaults to [] and getLocked coerces to boolean", () => {
    expect(getTraits(row({}))).toEqual([])
    expect(getTraits(row({ traits: ["#1"] }))).toEqual(["#1"])
    expect(getLocked(row({ locked: true }))).toBe(true)
    expect(getLocked(row({}))).toBe(false)
  })
})

describe("proxyTopShotThumb / getThumbnailUrl", () => {
  it("rewrites a Top Shot CDN url through the proxy", () => {
    const out = proxyTopShotThumb("https://assets.nbatopshot.com/media/abc123/image?width=250")
    expect(out).toBe("/api/moment-thumbnail?flowId=abc123&width=250")
  })

  it("leaves a non-matching url untouched", () => {
    expect(proxyTopShotThumb("https://example.com/x.png")).toBe("https://example.com/x.png")
  })

  it("getThumbnailUrl prefers momentId → proxy route", () => {
    expect(getThumbnailUrl(row({ momentId: "999" }))).toBe(
      "/api/moment-thumbnail?flowId=999&width=180"
    )
  })

  it("getThumbnailUrl returns null when nothing is available", () => {
    expect(getThumbnailUrl(row({}))).toBeNull()
  })
})

describe("getBestAsk", () => {
  it("returns the minimum of the non-zero ask fields", () => {
    expect(getBestAsk(row({ lowAsk: 30, bestAsk: 25, topshotAsk: 40 }))).toBe(25)
  })

  it("ignores zero / non-finite asks and returns null when none", () => {
    expect(getBestAsk(row({ lowAsk: 0, bestAsk: 0 }))).toBeNull()
    expect(getBestAsk(row({}))).toBeNull()
  })
})

describe("getPrimarySerialBadge", () => {
  it("prioritizes #1 > Perfect Mint > Jersey Match", () => {
    expect(getPrimarySerialBadge(row({ traits: ["Jersey Match", "#1"] }))).toBe("#1")
    expect(getPrimarySerialBadge(row({ traits: ["Perfect Mint", "Jersey Match"] }))).toBe("Perfect Mint")
    expect(getPrimarySerialBadge(row({ traits: ["Jersey Match"] }))).toBe("Jersey Match")
    expect(getPrimarySerialBadge(row({ traits: [] }))).toBeNull()
  })
})

describe("label helpers", () => {
  it("debugReasonLabel maps known reasons, echoes unknown", () => {
    expect(debugReasonLabel("NO_LOW_ASK")).toBe("No low ask")
    expect(debugReasonLabel("SPECIAL_SERIAL_NO_BASE")).toBe("No serial base")
    expect(debugReasonLabel(null)).toBe("—")
  })

  it("confidenceLabel maps each tier to a label", () => {
    expect(confidenceLabel("high").label).toBe("Liquid")
    expect(confidenceLabel("low").label).toBe("Thin")
    expect(confidenceLabel("no_data").label).toBe("Unpriced")
    expect(confidenceLabel("bogus").label).toBe("—")
  })
})

describe("fmvDisplay", () => {
  it("formats a positive fmv as $x.xx", () => {
    expect(fmvDisplay(row({ fmv: 42 }))).toEqual({ text: "$42.00", muted: false, stale: false })
  })

  it("falls back to fmvUsd and marks stale confidence muted", () => {
    expect(fmvDisplay(row({ fmvUsd: 10, marketConfidence: "stale" }))).toEqual({
      text: "$10.00",
      muted: true,
      stale: true,
    })
  })

  it("renders em-dash for missing / zero fmv", () => {
    expect(fmvDisplay(row({}))).toEqual({ text: "—", muted: true, stale: false })
    expect(fmvDisplay(row({ fmv: 0 }))).toEqual({ text: "—", muted: true, stale: false })
  })
})
