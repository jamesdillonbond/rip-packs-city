import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fmtUsd,
  truncateAddress,
  tierColor,
  tierHoloClass,
  collectionMetaByUuid,
  collectionMetaBySlug,
  timeAgo,
  formatCountdown,
} from "@/lib/dashboard-format"

describe("fmtUsd", () => {
  it("returns $0 for falsy (0 / NaN)", () => {
    expect(fmtUsd(0)).toBe("$0")
    expect(fmtUsd(NaN)).toBe("$0")
  })
  it("shows cents below 1000", () => {
    expect(fmtUsd(12.5)).toBe("$12.50")
    expect(fmtUsd(999.994)).toBe("$999.99")
  })
  it("rounds and thousands-separates at >= 1000, no cents", () => {
    expect(fmtUsd(1000)).toBe("$1,000")
    expect(fmtUsd(1234.56)).toBe("$1,235")
  })
})

describe("truncateAddress", () => {
  it("returns empty string for empty input", () => {
    expect(truncateAddress("")).toBe("")
  })
  it("middle-truncates a 0x Flow address", () => {
    expect(truncateAddress("0xbd94cade097e50ac")).toBe("0xbd94…50ac")
  })
  it("glues 0x onto a bare hex Flow address before truncating", () => {
    expect(truncateAddress("bd94cade097e50ac")).toBe("0xbd94…50ac")
  })
  it("does NOT glue 0x onto a Solana base58 address (would corrupt it)", () => {
    const sol = "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"
    const out = truncateAddress(sol)
    expect(out.startsWith("0x")).toBe(false)
    expect(out).toBe(sol.slice(0, 6) + "…" + sol.slice(-4))
  })
  it("returns short inputs (<=12 after normalization) unchanged", () => {
    expect(truncateAddress("0x1234")).toBe("0x1234")
  })
})

describe("tierColor", () => {
  it("maps both the raw and moment_tier_* forms to the same color", () => {
    expect(tierColor("ultimate")).toBe(tierColor("moment_tier_ultimate"))
    expect(tierColor("legendary")).toBe("#F59E0B")
    expect(tierColor("RARE")).toBe("#818CF8")
    expect(tierColor("fandom")).toBe("#34D399")
    expect(tierColor("common")).toBe("#9CA3AF")
  })
  it("falls back to a neutral gray for unknown / null tiers", () => {
    expect(tierColor(null)).toBe("#6B7280")
    expect(tierColor("champion")).toBe("#6B7280")
  })
})

describe("tierHoloClass", () => {
  it("returns a holo class for the three premium tiers (substring match)", () => {
    expect(tierHoloClass("moment_tier_ultimate")).toBe("rpc-holo-ultimate")
    expect(tierHoloClass("legendary")).toBe("rpc-holo-legendary")
    expect(tierHoloClass("Rare")).toBe("rpc-holo-rare")
  })
  it("returns empty string for non-premium / null", () => {
    expect(tierHoloClass("common")).toBe("")
    expect(tierHoloClass(null)).toBe("")
  })
})

describe("collectionMetaByUuid / collectionMetaBySlug", () => {
  it("resolves a published collection by its Supabase UUID", () => {
    // Top Shot's UUID (CLAUDE.md: schema facts)
    const meta = collectionMetaByUuid("95f28a17-224a-4025-96ad-adf8a4c63bfd")
    expect(meta).not.toBeNull()
    expect(meta?.supabaseCollectionId).toBe("95f28a17-224a-4025-96ad-adf8a4c63bfd")
  })
  it("returns null for an unknown UUID", () => {
    expect(collectionMetaByUuid("00000000-0000-0000-0000-000000000000")).toBeNull()
  })
  it("normalizes underscore slugs from the RPC before lookup", () => {
    const byUnderscore = collectionMetaBySlug("nba_top_shot")
    const byDash = collectionMetaBySlug("nba-top-shot")
    expect(byUnderscore).not.toBeNull()
    expect(byUnderscore).toBe(byDash)
  })
  it("returns null for an unknown slug", () => {
    expect(collectionMetaBySlug("not_a_collection")).toBeNull()
  })
})

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers())
  it("buckets into m / h / d ago relative to now", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"))
    expect(timeAgo("2026-08-01T11:30:00Z")).toBe("30m ago")
    expect(timeAgo("2026-08-01T09:00:00Z")).toBe("3h ago")
    expect(timeAgo("2026-07-29T12:00:00Z")).toBe("3d ago")
  })
})

describe("formatCountdown", () => {
  it("returns 'expired' at or below zero", () => {
    expect(formatCountdown(0)).toBe("expired")
    expect(formatCountdown(-5)).toBe("expired")
  })
  it("formats M:SS with zero-padded seconds", () => {
    expect(formatCountdown(65000)).toBe("1:05")
    expect(formatCountdown(600000)).toBe("10:00")
    expect(formatCountdown(9000)).toBe("0:09")
  })
})
