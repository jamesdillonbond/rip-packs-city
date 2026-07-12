import { describe, it, expect, vi, afterEach } from "vitest"
import {
  isVerifiedDeal,
  resolveViewUrl,
  resolveDapperUrl,
  timeAgo,
  trackClick,
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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.destination).toBe("flowty_listing")
    expect(body.surface).toBe("sniper")
    expect(body.walletAddress).toBe("0xabc")
  })

  it("maps a non-flowty deal to the topshot_listing destination", () => {
    const fetchMock = stubBrowser()
    trackClick(deal({ source: "topshot", momentId: "9", editionKey: null as any, buyUrl: "https://nbatopshot.com/m/9" }), null)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.destination).toBe("topshot_listing")
    expect(body.editionKey).toBeNull()
  })

  it("is a silent no-op outside a browser (no window)", () => {
    expect(() => trackClick(deal({ source: "topshot", momentId: "9" }), null)).not.toThrow()
  })
})
