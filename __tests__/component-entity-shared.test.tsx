// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import {
  fmtUsd, fmtCount, fmtPercent, truncWallet, relTime, tileSubject,
  marketplaceLabel, fmvBasisText, TierBadge, WalletLink, EM_DASH,
} from "@/components/entity/_shared"

afterEach(cleanup)

describe("_shared formatters", () => {
  it("fmtUsd em-dashes null/NaN/zero and formats large vs small differently", () => {
    expect(fmtUsd(null)).toBe(EM_DASH)
    expect(fmtUsd(NaN)).toBe(EM_DASH)
    expect(fmtUsd(0)).toBe(EM_DASH)
    // >= 100 → no cents; < 100 → two decimals.
    expect(fmtUsd(1234)).toBe("$1,234")
    expect(fmtUsd(4.5)).toBe("$4.50")
  })

  it("fmtCount groups thousands and em-dashes missing values", () => {
    expect(fmtCount(15000)).toBe("15,000")
    expect(fmtCount(null)).toBe(EM_DASH)
    expect(fmtCount(NaN)).toBe(EM_DASH)
  })

  it("fmtPercent adds a + sign for positive values only", () => {
    expect(fmtPercent(12.34)).toBe("+12.3%")
    expect(fmtPercent(-5)).toBe("-5.0%")
    expect(fmtPercent(0)).toBe("0.0%")
    expect(fmtPercent(null)).toBe(EM_DASH)
  })

  it("truncWallet lowercases, 0x-prefixes and shortens long addresses", () => {
    expect(truncWallet("0xABCDEF1234567890")).toBe("0xabcd…7890")
    // Adds the 0x prefix when missing.
    expect(truncWallet("ABCDEF1234567890")).toBe("0xabcd…7890")
    // Short address is returned as-is.
    expect(truncWallet("0x1234")).toBe("0x1234")
    expect(truncWallet(null)).toBe(EM_DASH)
  })

  it("relTime bucketises into minute/hour/day and em-dashes junk", () => {
    const now = Date.parse("2026-07-12T12:00:00Z")
    expect(relTime(new Date(now - 5 * 60_000).toISOString(), now)).toContain("minute")
    expect(relTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toContain("hour")
    expect(relTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toContain("day")
    expect(relTime(null)).toBe(EM_DASH)
    expect(relTime("not-a-date")).toBe(EM_DASH)
  })

  it("tileSubject prefers player, then '{team} {play}', then name, then 'Edition'", () => {
    expect(tileSubject({ player_name: "Damian Lillard" })).toBe("Damian Lillard")
    expect(tileSubject({ team_name: "Chicago Bulls", play_type: "Reel" })).toBe("Chicago Bulls Reel")
    // 'Unknown' play_type is dropped.
    expect(tileSubject({ team_name: "Chicago Bulls", play_type: "Unknown" })).toBe("Chicago Bulls")
    expect(tileSubject({ name: "Set Name" })).toBe("Set Name")
    expect(tileSubject({})).toBe("Edition")
  })

  it("marketplaceLabel canonicalises the collection vocabularies", () => {
    expect(marketplaceLabel("nba_top_shot")).toBe("Top Shot")
    expect(marketplaceLabel("allday")).toBe("All Day")
    expect(marketplaceLabel("ufc_strike")).toBe("UFC Strike")
    expect(marketplaceLabel("flowty")).toBe("Flowty (historical)")
    expect(marketplaceLabel(null)).toBe(EM_DASH)
  })

  it("fmvBasisText joins sales + ask, handles singular, and returns null with no basis", () => {
    expect(fmvBasisText({ confidence: null, salesCount30d: 12, ask: 120 })).toBe("12 sales (30d) · ask $120")
    expect(fmvBasisText({ confidence: null, salesCount30d: 1, ask: null })).toBe("1 sale (30d)")
    expect(fmvBasisText({ confidence: null, salesCount30d: 0, ask: 45 })).toBe("ask $45.00")
    expect(fmvBasisText({ confidence: null, salesCount30d: 0, ask: 0 })).toBeNull()
  })

  it("TierBadge renders nothing without a tier and uses the label override when given", () => {
    expect(render(<TierBadge tier={null} />).container.firstChild).toBeNull()
    cleanup()
    const { container } = render(<TierBadge tier="legendary" label="LEG" />)
    expect(container.textContent).toBe("LEG")
  })

  it("WalletLink em-dashes a missing address and links a present one to /profile", () => {
    expect(render(<WalletLink address={null} />).container.textContent).toBe(EM_DASH)
    cleanup()
    const { container } = render(<WalletLink address="0xAbC1234567890000" name="ripper" />)
    const a = container.querySelector("a")!
    expect(a.getAttribute("href")).toBe("/profile/0xabc1234567890000")
    expect(a.textContent).toBe("@ripper")
  })
})
