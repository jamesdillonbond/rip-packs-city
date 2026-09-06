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
  sortKeyToServerSort,
  duplicateGroupKey,
  computeDuplicateEditionKeys,
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

  // 2026-09-06: /api/moment-thumbnail is a TOP SHOT resource keyed on a Top Shot
  // moment id. Golazos ids 404'd through it (45/47 tiles on the founder's wallet)
  // and All Day ids COLLIDED with Top Shot ids and rendered another sport's art.
  it("a non-Top-Shot collection renders its OWN edition art, never the Top Shot media proxy", () => {
    const allday = row({ momentId: "1652251", thumbnailUrl: "https://media.nflallday.com/editions/675/media/image?width=512" })
    expect(getThumbnailUrl(allday, "nfl-all-day")).toBe("https://media.nflallday.com/editions/675/media/image?width=512")
    const golazos = row({ momentId: "737217859", thumbnailUrl: "https://assets.laligagolazos.com/editions/x/play_x.png" })
    expect(getThumbnailUrl(golazos, "laliga-golazos")).toBe("https://assets.laligagolazos.com/editions/x/play_x.png")
    expect(getThumbnailUrl(golazos, "laliga-golazos")).not.toContain("moment-thumbnail")
    // no edition art → honest null (the tile shows its placeholder), not a wrong picture
    expect(getThumbnailUrl(row({ momentId: "737217859" }), "laliga-golazos")).toBeNull()
    // Top Shot keeps the proxy
    expect(getThumbnailUrl(row({ momentId: "999" }), "nba-top-shot")).toBe("/api/moment-thumbnail?flowId=999&width=180")
    // ipfs-hosted art (UFC-style) on any collection still goes through the ipfs proxy
    expect(getThumbnailUrl(row({ momentId: "1", thumbnailUrl: "https://ipfs.io/ipfs/QmABC" }), "disney-pinnacle")).toBe("/api/public/ipfs-media/QmABC")
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
    expect(fmvDisplay(row({ fmv: 42 }))).toEqual({ text: "$42.00", muted: false, stale: false, askDerived: false })
  })

  it("falls back to fmvUsd and marks stale confidence muted", () => {
    expect(fmvDisplay(row({ fmvUsd: 10, marketConfidence: "stale" }))).toEqual({
      text: "$10.00",
      muted: true,
      stale: true,
      askDerived: false,
    })
  })

  it("flags an ASK_ONLY fmv as ask-derived (for the 'from asks' marker)", () => {
    expect(fmvDisplay(row({ fmv: 30, marketConfidence: "ask_only" }))).toEqual({
      text: "$30.00",
      muted: false,
      stale: false,
      askDerived: true,
    })
  })

  it("renders em-dash for missing / zero fmv", () => {
    expect(fmvDisplay(row({}))).toEqual({ text: "—", muted: true, stale: false, askDerived: false })
    expect(fmvDisplay(row({ fmv: 0 }))).toEqual({ text: "—", muted: true, stale: false, askDerived: false })
  })
})

describe("sortKeyToServerSort — sort UI state → server sortBy param", () => {
  it("maps the four server-sortable keys with direction", () => {
    expect(sortKeyToServerSort("fmv", "asc")).toBe("fmv_asc")
    expect(sortKeyToServerSort("fmv", "desc")).toBe("fmv_desc")
    expect(sortKeyToServerSort("serial", "asc")).toBe("serial_asc")
    expect(sortKeyToServerSort("serial", "desc")).toBe("serial_asc") // serial is always ascending
    expect(sortKeyToServerSort("acquired", "desc")).toBe("recent")
    expect(sortKeyToServerSort("paid", "asc")).toBe("paid_asc")
    expect(sortKeyToServerSort("paid", "desc")).toBe("paid_desc")
  })
  it("a client-only key falls back to fmv (respecting direction)", () => {
    expect(sortKeyToServerSort("player" as never, "asc")).toBe("fmv_asc")
    expect(sortKeyToServerSort("player" as never, "desc")).toBe("fmv_desc")
  })
})

describe("duplicateGroupKey / computeDuplicateEditionKeys — the 'duplicates only' filter", () => {
  it("groups by set + player + parallel", () => {
    const k = duplicateGroupKey(row({ setName: "Base", playerName: "LeBron", parallel: "Standard" }))
    expect(k).toContain("Base")
    expect(k).toContain("LeBron")
  })
  it("two rows with the same set+player+parallel share a key; a different parallel does not", () => {
    const a = duplicateGroupKey(row({ setName: "Base", playerName: "LeBron", parallel: "Standard" }))
    const b = duplicateGroupKey(row({ setName: "Base", playerName: "LeBron", parallel: "Standard" }))
    const c = duplicateGroupKey(row({ setName: "Base", playerName: "LeBron", parallel: "Hexwave" }))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
  it("returns only the keys that appear more than once", () => {
    const rows = [
      row({ setName: "Base", playerName: "LeBron" }),
      row({ setName: "Base", playerName: "LeBron" }), // dup with #1
      row({ setName: "Base", playerName: "Curry" }), // unique
    ]
    const dups = computeDuplicateEditionKeys(rows)
    expect(dups.size).toBe(1)
    expect(dups.has(duplicateGroupKey(rows[0]))).toBe(true)
    expect(dups.has(duplicateGroupKey(rows[2]))).toBe(false)
  })
  it("empty list → empty set", () => {
    expect(computeDuplicateEditionKeys([]).size).toBe(0)
  })
})
