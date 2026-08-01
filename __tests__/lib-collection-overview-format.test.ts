import { describe, it, expect, vi, afterEach } from "vitest"
import { nameOrDash, fmtPrice, fmtAge, minutesSince, freshnessFromAge } from "@/lib/collection-overview-format"

describe("collection-overview-format — nameOrDash / fmtPrice", () => {
  it("nameOrDash returns the first non-blank candidate, else em-dash", () => {
    expect(nameOrDash(null, "  ", "Curry", "LeBron")).toBe("Curry")
    expect(nameOrDash(null, undefined, "   ")).toBe("—")
  })
  it("fmtPrice rounds and groups", () => {
    expect(fmtPrice(1234.6)).toBe("$1,235")
  })
})

describe("collection-overview-format — fmtAge / minutesSince", () => {
  afterEach(() => vi.useRealTimers())
  it("fmtAge buckets by minutes, em-dash for null", () => {
    expect(fmtAge(null)).toBe("—")
    expect(fmtAge(0.5)).toBe("just now")
    expect(fmtAge(45)).toBe("45 min ago")
    expect(fmtAge(90)).toBe("1h ago")
    expect(fmtAge(60 * 26)).toBe("1d ago")
  })
  it("minutesSince returns non-negative minutes, null for empty/unparseable", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-01T01:00:00Z"))
    expect(minutesSince(null)).toBeNull()
    expect(minutesSince("nope")).toBeNull()
    expect(minutesSince("2026-06-01T00:30:00Z")).toBeCloseTo(30, 5)
    // Future timestamp clamps to 0, never negative.
    expect(minutesSince("2026-06-01T02:00:00Z")).toBe(0)
  })
})

describe("collection-overview-format — freshnessFromAge", () => {
  it("loading short-circuits before everything", () => {
    expect(freshnessFromAge(5, true).label).toBe("Loading…")
    expect(freshnessFromAge(5, true).loading).toBe(true)
  })
  it("frozen market renders the neutral ARCHIVED pill, not OUTDATED", () => {
    // 10,000 minutes stale would be OUTDATED, but a frozen market is archival.
    expect(freshnessFromAge(10_000, false, true).label).toBe("ARCHIVED")
  })
  it("unknown age → UNKNOWN", () => {
    expect(freshnessFromAge(null, false).label).toBe("UNKNOWN")
  })
  it("buckets LIVE (<30m) / DELAYED (<60m) / OUTDATED (>=60m)", () => {
    expect(freshnessFromAge(10, false).label).toBe("LIVE")
    expect(freshnessFromAge(45, false).label).toBe("DELAYED")
    expect(freshnessFromAge(120, false).label).toBe("OUTDATED")
  })
})
