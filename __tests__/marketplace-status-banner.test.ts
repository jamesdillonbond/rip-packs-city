import { describe, it, expect, afterEach, vi } from "vitest"
import { bannerCopy, infoNotice, resolveBannerCopy } from "@/lib/marketplace-status-banner"

// Pins the per-collection marketplace-status banner copy + precedence (extracted
// from MarketplaceStatusBanner). A wrong warning or a stale promo past its window
// is a user-facing trust bug, so every status/slug branch is covered here.

describe("bannerCopy — status × slug warning copy", () => {
  it("shutdown + ufc → the UFC/Aptos-specific red warning", () => {
    const c = bannerCopy("ufc", "shutdown", null)
    expect(c?.title).toContain("UFC Strike")
    expect(c?.body).toContain("Aptos")
    expect(c?.accent).toBe("var(--rpc-red)")
  })

  it("shutdown + other slug → generic shutdown copy, using notes when provided", () => {
    expect(bannerCopy("nba-top-shot", "shutdown", null)?.title).toBe("Marketplace shut down")
    expect(bannerCopy("nba-top-shot", "shutdown", "Custom sunset note")?.body).toBe("Custom sunset note")
  })

  it("unknown + laliga-golazos → the Golazos-specific amber copy", () => {
    const c = bannerCopy("laliga-golazos", "unknown", null)
    expect(c?.title).toBe("No confirmed Flow marketplace")
    expect(c?.accent).toBe("#F59E0B")
  })

  it("unknown + other → generic uncertain copy, notes override the body", () => {
    expect(bannerCopy("x", "unknown", null)?.title).toBe("Marketplace status uncertain")
    expect(bannerCopy("x", "unknown", "note")?.body).toBe("note")
  })

  it("dormant vs degraded → distinct titles, amber accent", () => {
    expect(bannerCopy("x", "dormant", null)?.title).toBe("Marketplace dormant")
    expect(bannerCopy("x", "degraded", null)?.title).toBe("Marketplace degraded")
    expect(bannerCopy("x", "dormant", null)?.accent).toBe("#F59E0B")
  })

  it("healthy or unrecognized status → no warning copy", () => {
    expect(bannerCopy("x", "healthy", null)).toBeNull()
    expect(bannerCopy("x", "whatever", null)).toBeNull()
  })
})

describe("infoNotice — time-boxed positive notices", () => {
  afterEach(() => vi.useRealTimers())

  it("shows the AllDay rebate notice before the window closes (green accent, not a warning)", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"))
    const n = infoNotice("nfl-all-day")
    expect(n?.title).toContain("rebate")
    expect(n?.accent).toBe("#10B981")
  })

  it("self-expires the AllDay notice once past 2026-09-10", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-10T00:00:01Z"))
    expect(infoNotice("nfl-all-day")).toBeNull()
  })

  it("returns null for any other slug", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"))
    expect(infoNotice("nba-top-shot")).toBeNull()
  })
})

describe("resolveBannerCopy — warning wins over info notice", () => {
  afterEach(() => vi.useRealTimers())

  it("a non-healthy status shows its warning, not the info notice", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z")) // inside the AllDay promo window
    // nfl-all-day is 'shutdown' here → warning must take precedence over the promo.
    const c = resolveBannerCopy("nfl-all-day", "shutdown", null)
    expect(c?.title).toBe("Marketplace shut down")
    expect(c?.accent).toBe("var(--rpc-red)")
  })

  it("a healthy status falls through to a live info notice", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"))
    expect(resolveBannerCopy("nfl-all-day", "healthy", null)?.accent).toBe("#10B981")
  })

  it("a healthy status with no info notice renders nothing", () => {
    expect(resolveBannerCopy("nba-top-shot", "healthy", null)).toBeNull()
  })
})
