import { describe, it, expect, vi, afterEach } from "vitest"
import { fmtInt, timeAgo, fmtIso, truncSig, truncAddr, truncMid } from "@/lib/admin/flowty-errors-format"

describe("flowty-errors-format — fmtInt", () => {
  it("returns em-dash for null/NaN, rounds+groups otherwise", () => {
    expect(fmtInt(null)).toBe("—")
    expect(fmtInt(NaN)).toBe("—")
    expect(fmtInt(1234.6)).toBe("1,235")
  })
})

describe("flowty-errors-format — timeAgo", () => {
  afterEach(() => vi.useRealTimers())
  it("guards empty + unparseable dates", () => {
    expect(timeAgo(null)).toBe("—")
    expect(timeAgo("nope")).toBe("—")
  })
  it("buckets just-now / m / h / d", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"))
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(timeAgo(ago(30_000))).toBe("just now")
    expect(timeAgo(ago(5 * 60_000))).toBe("5m ago")
    expect(timeAgo(ago(3 * 3_600_000))).toBe("3h ago")
    expect(timeAgo(ago(2 * 86_400_000))).toBe("2d ago")
  })
})

describe("flowty-errors-format — fmtIso", () => {
  it("guards empty + unparseable, renders 'YYYY-MM-DD HH:MM:SS UTC'", () => {
    expect(fmtIso(null)).toBe("—")
    expect(fmtIso("bad")).toBe("—")
    expect(fmtIso("2026-06-01T12:34:56.789Z")).toBe("2026-06-01 12:34:56 UTC")
  })
})

describe("flowty-errors-format — truncSig / truncAddr / truncMid", () => {
  it("truncSig keeps short, tails long with default len 28", () => {
    expect(truncSig(null)).toBe("—")
    expect(truncSig("short")).toBe("short")
    expect(truncSig("x".repeat(40))).toBe("x".repeat(28) + "…")
  })
  it("truncAddr middle-ellipsizes over 14 chars", () => {
    expect(truncAddr(null)).toBe("—")
    expect(truncAddr("0x1234567890")).toBe("0x1234567890")
    expect(truncAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
  })
  it("truncMid tails long strings at len (default 80)", () => {
    expect(truncMid(null)).toBe("—")
    expect(truncMid("hello")).toBe("hello")
    expect(truncMid("y".repeat(100), 10)).toBe("y".repeat(10) + "…")
  })
})
