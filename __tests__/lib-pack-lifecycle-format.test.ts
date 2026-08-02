import { describe, it, expect, vi, afterEach } from "vitest"
import {
  shortAddr,
  shortHash,
  flowscanTxUrl,
  flowscanAccountUrl,
  relativeTime,
  fmtUsd,
  fmtPrice,
  fmtPriceWithUsd,
  formatMonthYear,
  resizedThumb,
  tierTokenKey,
  TIER_ALIASES,
} from "@/lib/pack-lifecycle-format"

describe("pack-lifecycle-format — shortAddr / shortHash", () => {
  it("returns em-dash for empty input", () => {
    expect(shortAddr(null)).toBe("—")
    expect(shortHash(undefined)).toBe("—")
  })
  it("returns short values unchanged", () => {
    expect(shortAddr("0x1234")).toBe("0x1234")
    expect(shortHash("abc")).toBe("abc")
  })
  it("truncates long addresses/hashes with an ellipsis", () => {
    expect(shortAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
    expect(shortHash("0123456789abcdef0123")).toBe("01234567…ef0123")
  })
})

describe("pack-lifecycle-format — flowscan URLs", () => {
  it("builds tx + account URLs, url-encoding the segment", () => {
    expect(flowscanTxUrl("abc123")).toBe("https://www.flowscan.io/tx/abc123")
    expect(flowscanAccountUrl("0xdef")).toBe("https://www.flowscan.io/account/0xdef")
    expect(flowscanTxUrl("a/b")).toBe("https://www.flowscan.io/tx/a%2Fb")
  })
})

describe("pack-lifecycle-format — relativeTime", () => {
  afterEach(() => vi.useRealTimers())
  it("returns '' for empty or unparseable input", () => {
    expect(relativeTime(null)).toBe("")
    expect(relativeTime("not-a-date")).toBe("")
  })
  it("buckets by seconds/minutes/hours/days/months/years", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"))
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(relativeTime(ago(5_000))).toBe("5s ago")
    expect(relativeTime(ago(5 * 60_000))).toBe("5m ago")
    expect(relativeTime(ago(3 * 3_600_000))).toBe("3h ago")
    expect(relativeTime(ago(4 * 86_400_000))).toBe("4d ago")
    expect(relativeTime(ago(60 * 86_400_000))).toBe("2mo ago")
    expect(relativeTime(ago(400 * 86_400_000))).toBe("1y ago")
  })
})

describe("pack-lifecycle-format — fmtUsd", () => {
  it("returns em-dash for empty/non-finite", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd("")).toBe("—")
    expect(fmtUsd("abc")).toBe("—")
  })
  it("drops .00 on whole dollars, keeps 2 decimals otherwise", () => {
    expect(fmtUsd(20)).toBe("$20")
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(19.5)).toBe("$19.50")
    expect(fmtUsd("12.34")).toBe("$12.34")
  })
})

describe("pack-lifecycle-format — fmtPrice / fmtPriceWithUsd", () => {
  it("fmtPrice appends the currency when present", () => {
    expect(fmtPrice(12.3456, "FLOW")).toBe("12.3456 FLOW")
    expect(fmtPrice(5, null)).toBe("5")
    expect(fmtPrice(null, "FLOW")).toBe("—")
  })
  it("fmtPriceWithUsd renders DUC as plain USD (drops the suffix)", () => {
    expect(fmtPriceWithUsd(20, "DUC")).toBe("$20")
    expect(fmtPriceWithUsd(20, "duc")).toBe("$20")
  })
  it("fmtPriceWithUsd keeps non-DUC currency suffixes", () => {
    expect(fmtPriceWithUsd(3.5, "FLOW")).toBe("3.5 FLOW")
    expect(fmtPriceWithUsd(null, "USDC")).toBe("—")
  })
})

describe("pack-lifecycle-format — formatMonthYear", () => {
  it("returns null for empty/unparseable", () => {
    expect(formatMonthYear(null)).toBeNull()
    expect(formatMonthYear("nope")).toBeNull()
  })
  it("formats as 'Mon YYYY'", () => {
    expect(formatMonthYear("2022-12-15T00:00:00Z")).toMatch(/^\w{3} 2022$/)
  })
})

describe("pack-lifecycle-format — resizedThumb", () => {
  it("returns null for empty", () => {
    expect(resizedThumb(null)).toBeNull()
  })
  it("rewrites Top Shot edition CDN URLs through the resize endpoint at the given width", () => {
    const out = resizedThumb("https://assets.nbatopshot.com/editions/x/Hero.png", 300)
    expect(out).toBe("https://assets.nbatopshot.com/resize/editions/x/Hero.png?format=webp&quality=80&width=300")
  })
  it("defaults width to 900", () => {
    expect(resizedThumb("https://assets.nbatopshot.com/editions/y.png")).toContain("width=900")
  })
  it("passes non-Top-Shot URLs through unchanged", () => {
    expect(resizedThumb("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png")
  })
})

describe("tierTokenKey", () => {
  it("maps a known tier (any case) to its lowercase token key", () => {
    expect(tierTokenKey("LEGENDARY")).toBe("legendary")
    expect(tierTokenKey("legendary")).toBe("legendary")
    expect(tierTokenKey("Rare")).toBe("rare")
  })
  it("covers the UFC vocabulary", () => {
    expect(tierTokenKey("CHALLENGER")).toBe("challenger")
    expect(tierTokenKey("CONTENDER")).toBe("contender")
    expect(tierTokenKey("FANDOM")).toBe("fandom")
  })
  it("falls back to 'common' for null and unknown tiers", () => {
    expect(tierTokenKey(null)).toBe("common")
    expect(tierTokenKey("")).toBe("common")
    expect(tierTokenKey("MYTHIC")).toBe("common")
  })
  it("TIER_ALIASES keys are uppercase and map to their lowercase form", () => {
    for (const [k, v] of Object.entries(TIER_ALIASES)) {
      expect(k).toBe(k.toUpperCase())
      expect(v).toBe(k.toLowerCase())
    }
  })
})
