import { describe, it, expect, vi, afterEach } from "vitest"
import {
  isVerifiedDeal,
  resolveViewUrl,
  resolveDapperUrl,
  timeAgo,
  trackClick,
  fmt,
  fmvDisplay,
  safeRatioDiff,
  tierColor,
  allDayTierColor,
  resolveTierColor,
  holoClass,
  variantLabel,
  discountColor,
  countHiddenByVerifiedGate,
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
  it("false when confidence is missing/undefined (empty-string coalesce)", () => {
    expect(isVerifiedDeal(deal({}))).toBe(false)
    expect(isVerifiedDeal(deal({ confidence: "NO_DATA" }))).toBe(false)
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
  it("tierColor maps to a CSS var, unknown → neutral (was: --tier-common)", () => {
    // 2026-08-01: an unknown tier used to be dressed up as COMMON — a real tier
    // colour for a tier we could not identify. Now the neutral muted token,
    // matching lib/market-format + lib/moment-detail-format.
    expect(tierColor("LEGENDARY")).toBe("var(--tier-legendary)")
    expect(tierColor("mystery")).toBe("var(--rpc-text-muted)")
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
    expect(discountColor(40).color).toBeDefined() // >=30 bucket
    expect(discountColor(20).color).toBeDefined() // >=15 bucket
    expect(discountColor(8).color).toBeDefined()  // >=5 bucket
    expect(discountColor(1)).toEqual({ border: "1px solid var(--rpc-border)" }) // <5 plain
  })
})

describe("resolveViewUrl per-collection native fallback", () => {
  it("falls back to each collection's native moment page for Flowty links", () => {
    expect(resolveViewUrl(deal({ buyUrl: "https://flowty.io/x", momentId: "9" }), "nfl-all-day")).toBe(
      "https://nflallday.com/moments/9"
    )
    expect(resolveViewUrl(deal({ buyUrl: "https://flowty.io/x", momentId: "9" }), "laliga-golazos")).toBe(
      "https://laligagolazos.com/moments/9"
    )
    expect(resolveViewUrl(deal({ buyUrl: "https://flowty.io/x", momentId: "9" }), "disney-pinnacle")).toBe(
      "https://disneypinnacle.com/pin/9"
    )
  })
  it("returns null when there is no buyUrl and the collection has no template", () => {
    expect(resolveViewUrl(deal({ momentId: "9" }), "ufc")).toBeNull()
  })
})

describe("resolveDapperUrl per-collection segments", () => {
  it("builds a laliga dapper link for a numeric moment id", () => {
    expect(resolveDapperUrl(deal({ source: "golazos", momentId: "12" }), "laliga-golazos")).toBe(
      "https://dapper.market/laliga/moment/12"
    )
  })
  it("returns null for a collection dapper.market does not carry (pinnacle)", () => {
    expect(resolveDapperUrl(deal({ source: "pinnacle", momentId: "12" }), "disney-pinnacle")).toBeNull()
  })
  it("returns null when there is no moment id at all", () => {
    expect(resolveDapperUrl(deal({ source: "topshot", momentId: "" }), "nba-top-shot")).toBeNull()
  })
})

describe("timeAgo buckets", () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()
  it("renders the em-dash for null", () => {
    expect(timeAgo(null)).toBe("—")
  })
  it("clamps future / sub-minute timestamps to 'just now'", () => {
    expect(timeAgo(new Date(Date.now() + 60000).toISOString())).toBe("just now")
    expect(timeAgo(isoAgo(30_000))).toBe("just now")
  })
  it("buckets minutes / hours / days", () => {
    expect(timeAgo(isoAgo(5 * 60_000))).toBe("5m ago")
    expect(timeAgo(isoAgo(3 * 3_600_000))).toBe("3h ago")
    expect(timeAgo(isoAgo(2 * 86_400_000))).toBe("2d ago")
  })
})

describe("trackClick", () => {
  afterEach(() => vi.unstubAllGlobals())

  // trackClick → trackOutboundClick, which is a no-op unless `window` exists.
  // Stub a minimal window/navigator (no sendBeacon) so it takes the fetch
  // fallback path, then assert the outbound destination is derived from source.
  function stubBrowser() {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }))
    vi.stubGlobal("window", { sessionStorage: { getItem: () => "sess", setItem: () => {} }, crypto: {} })
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  it("maps a flowty deal to the flowty_listing destination", () => {
    const fetchMock = stubBrowser()
    expect(() =>
      trackClick(deal({ source: "flowty", momentId: "9", editionKey: "e", buyUrl: "https://flowty.io/x" }), "0xabc")
    ).not.toThrow()
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.destination).toBe("flowty_listing")
    expect(body.surface).toBe("sniper")
    expect(body.walletAddress).toBe("0xabc")
  })

  it("maps a non-flowty deal to the topshot_listing destination", () => {
    const fetchMock = stubBrowser()
    trackClick(deal({ source: "topshot", momentId: "9", editionKey: null as any, buyUrl: "https://nbatopshot.com/m/9" }), null)
    const body = JSON.parse((fetchMock.mock.calls[0] as any[])[1].body)
    expect(body.destination).toBe("topshot_listing")
    expect(body.editionKey).toBeNull()
  })

  it("is a silent no-op outside a browser (no window)", () => {
    expect(() => trackClick(deal({ source: "topshot", momentId: "9" }), null)).not.toThrow()
  })
})

// ── No-fabrication rendering (2026-07-25) ─────────────────────────────────────
// Standing policy: never invent a value where data is absent. An em-dash is
// always correct; "$0.00" and a substituted number are not. These two helpers
// are the last line of defence for the sniper board's FMV column and its
// avg-sale trend arrow.
describe("fmvDisplay", () => {
  it("renders a real FMV as a dollar figure", () => {
    expect(fmvDisplay(123.4)).toBe("$123.40")
    expect(fmvDisplay(1250)).toBe("$1,250.00")
  })

  it("renders an em-dash for null / undefined — never $0.00", () => {
    expect(fmvDisplay(null)).toBe("—")
    expect(fmvDisplay(undefined)).toBe("—")
    expect(fmvDisplay(null)).not.toContain("$")
    expect(fmvDisplay(null)).not.toContain("0.00")
  })

  it("renders an em-dash for 0 and for negatives (a $0.00 fair value is not a price)", () => {
    expect(fmvDisplay(0)).toBe("—")
    expect(fmvDisplay(-5)).toBe("—")
  })

  it("renders an em-dash for NaN / Infinity rather than 'NaN' or '∞'", () => {
    expect(fmvDisplay(Number.NaN)).toBe("—")
    expect(fmvDisplay(Number.POSITIVE_INFINITY)).toBe("—")
  })
})

describe("safeRatioDiff", () => {
  it("computes the ratio against a real base", () => {
    expect(safeRatioDiff(120, 100)).toBeCloseTo(0.2)
    expect(safeRatioDiff(80, 100)).toBeCloseTo(-0.2)
  })

  it("returns null for a zero / null / negative base instead of Infinity", () => {
    expect(safeRatioDiff(120, 0)).toBeNull()
    expect(safeRatioDiff(120, null)).toBeNull()
    expect(safeRatioDiff(120, undefined)).toBeNull()
    expect(safeRatioDiff(120, -1)).toBeNull()
    // the bug this replaces: (120 - 0) / 0 === Infinity -> a spurious ↑ arrow
    expect(safeRatioDiff(120, 0)).not.toBe(Number.POSITIVE_INFINITY)
  })

  it("returns null for a null / NaN numerator", () => {
    expect(safeRatioDiff(null, 100)).toBeNull()
    expect(safeRatioDiff(Number.NaN, 100)).toBeNull()
  })
})

describe("countHiddenByVerifiedGate (deep-audit D4)", () => {
  // The board Trevor saw: 200 listings, none verified, KPI row reading "0 deals"
  // next to an Overview tab advertising sniper deals. The gate was correct — the
  // rows are ask-derived, FMV == ask, 0% spread — but the empty state blamed
  // "your filters" for a default the user never set.
  const askPriced = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      full({ playerName: `p${i}`, confidence: "ask_only", confidenceSource: "ask_fallback" }),
    )

  function full(o: Partial<SniperDeal> = {}): SniperDeal {
    return {
      discount: 0,
      playerName: "x",
      setName: "s",
      teamName: "t",
      ...o,
    } as SniperDeal
  }

  it("counts what the gate alone is hiding", () => {
    const deals = [...askPriced(199), full({ confidence: "high", playerName: "real" })]
    expect(countHiddenByVerifiedGate(deals, { showVerifiedOnly: true })).toBe(199)
  })

  it("returns 0 when the gate is off, with no separate guard needed", () => {
    expect(countHiddenByVerifiedGate(askPriced(200), { showVerifiedOnly: false })).toBe(0)
    expect(countHiddenByVerifiedGate(askPriced(200), {})).toBe(0)
  })

  it("counts only the gate — not rows the OTHER filters already dropped", () => {
    // A negative-discount row is dropped by filterSniperDeals regardless of the
    // gate, so attributing it to the gate would overstate the hidden count and
    // promise the user listings that toggling off will not reveal.
    const deals = [
      ...askPriced(3),
      full({ discount: -5, confidence: "ask_only", confidenceSource: "ask_fallback" }),
    ]
    expect(countHiddenByVerifiedGate(deals, { showVerifiedOnly: true })).toBe(3)
  })

  it("respects the search box, so the count matches what the user would see", () => {
    const deals = [
      full({ playerName: "Curry", confidence: "ask_only", confidenceSource: "ask_fallback" }),
      full({ playerName: "Doncic", confidence: "ask_only", confidenceSource: "ask_fallback" }),
    ]
    expect(countHiddenByVerifiedGate(deals, { showVerifiedOnly: true, search: "curry" })).toBe(1)
  })

  it("is 0 when every row is verified (the healthy board)", () => {
    const deals = [full({ confidence: "high" }), full({ confidence: "medium" })]
    expect(countHiddenByVerifiedGate(deals, { showVerifiedOnly: true })).toBe(0)
  })
})
