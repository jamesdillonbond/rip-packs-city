import { describe, it, expect, vi, afterEach } from "vitest"
import { fmtUsd, relativeTime, truncAddr } from "@/lib/dashboard/format"

describe("dashboard/format — fmtUsd", () => {
  it("em-dash for null/non-finite, $0 for zero", () => {
    expect(fmtUsd(null)).toBe("—")
    expect(fmtUsd("x" as unknown as number)).toBe("—")
    expect(fmtUsd(0)).toBe("$0")
  })
  it("whole dollars ≥ $1,000, 2 decimals below", () => {
    expect(fmtUsd(2500.6)).toBe("$2,501")
    expect(fmtUsd(12.5)).toBe("$12.50")
  })
})

describe("dashboard/format — relativeTime", () => {
  afterEach(() => vi.useRealTimers())
  it("em-dash for empty/unparseable", () => {
    expect(relativeTime(null)).toBe("—")
    expect(relativeTime("nope")).toBe("—")
  })
  it("buckets just-now/m/h/d/mo/y", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"))
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(relativeTime(ago(30_000))).toBe("just now")
    expect(relativeTime(ago(5 * 60_000))).toBe("5m ago")
    expect(relativeTime(ago(3 * 3_600_000))).toBe("3h ago")
    expect(relativeTime(ago(5 * 86_400_000))).toBe("5d ago")
    expect(relativeTime(ago(60 * 86_400_000))).toBe("2mo ago")
    expect(relativeTime(ago(400 * 86_400_000))).toBe("1y ago")
  })
})

describe("dashboard/format — truncAddr", () => {
  it("returns '' for null (history-page variant), passes short, ellipsizes long", () => {
    expect(truncAddr(null)).toBe("")
    expect(truncAddr("0x1234")).toBe("0x1234")
    expect(truncAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
  })
})
