import { describe, it, expect } from "vitest"

// Pure-logic tests for the buyback surface's honesty rules.
//
// Two separate false claims are guarded here, and they point in OPPOSITE
// directions:
//   * an unpriced purchase must not render as "$0.00" (overstating certainty);
//   * a small verified count must not render without saying that 161,366
//     unreliable rows were discarded (understating activity, and reading as
//     "Top Shot stopped buying").
// These assert the ABSENCE of the false claim, not merely the presence of copy.

import {
  formatCount,
  formatUsd,
  exclusionNotice,
  observationNotice,
  spendCoverageNotice,
  walletLabel,
  walletSpendDisplay,
  NO_FIGURE,
  type BuybackCoverage,
  type BuybackTotals,
  type BuybackWallet,
} from "@/lib/analytics/buyback"

const wallet = (over: Partial<BuybackWallet> = {}): BuybackWallet => ({
  address: "0xe1f2a091f7bb5245",
  username: "TopShot_Buyback_2",
  purchases: 431,
  priced_acquisitions: 431,
  spend_usd: 10081.93,
  distinct_editions: 138,
  spend_known: true,
  ...over,
})

const totals = (over: Partial<BuybackTotals> = {}): BuybackTotals => ({
  purchases: 431,
  priced_purchases: 431,
  spend_usd: 10081.93,
  spend_known: true,
  distinct_editions: 138,
  active_days: 48,
  ...over,
})

const coverage = (over: Partial<BuybackCoverage> = {}): BuybackCoverage => ({
  observation_start: "2026-06-09",
  unpriced_purchases: 0,
  counterparty_known_for: 431,
  date_grain: "day",
  excluded_snapshot_rows: 161366,
  excluded_wallets: 1,
  excluded_reason: "41,301 of 41,307 distinct moments were already held on the first snapshot",
  ...over,
})

describe("walletSpendDisplay", () => {
  it("an unpriced wallet reads as an em-dash, NEVER as $0", () => {
    const d = walletSpendDisplay(
      wallet({ spend_known: false, spend_usd: null, priced_acquisitions: 0 })
    )
    expect(d.known).toBe(false)
    expect(d.text).toBe(NO_FIGURE)
    expect(d.text).not.toMatch(/\$\s*0/)
    expect(d.note).toMatch(/no price recorded/i)
  })

  it("a wallet whose spend is known renders the figure with no caveat", () => {
    const d = walletSpendDisplay(wallet())
    expect(d.known).toBe(true)
    expect(d.text).toBe("$10.1k")
    expect(d.note).toBeNull()
  })

  it("spend_known true but a null total still refuses to invent a number", () => {
    const d = walletSpendDisplay(wallet({ spend_known: true, spend_usd: null }))
    expect(d.known).toBe(false)
    expect(d.text).toBe(NO_FIGURE)
  })
})

describe("exclusionNotice", () => {
  it("states how many unreliable rows were discarded, so a small board is explicable", () => {
    const n = exclusionNotice(coverage())
    expect(n).not.toBeNull()
    expect(n!.headline).toContain("161,366")
    expect(n!.headline).toMatch(/excluded as unreliable/i)
    expect(n!.detail).toContain("41,301")
  })

  it("falls back to fixed copy when the RPC supplies no reason", () => {
    const n = exclusionNotice(coverage({ excluded_reason: null }))
    expect(n!.detail).toMatch(/wallet walk is unstable/i)
  })

  it("is SUPPRESSED when nothing was excluded — the note must not outlive the problem", () => {
    expect(exclusionNotice(coverage({ excluded_snapshot_rows: 0 }))).toBeNull()
  })
})

describe("spendCoverageNotice", () => {
  it("discloses the unpriced share when any purchase is unpriced", () => {
    const n = spendCoverageNotice(
      totals({ purchases: 500, priced_purchases: 431 }),
      coverage({ unpriced_purchases: 69 })
    )
    expect(n).not.toBeNull()
    expect(n!.headline).toContain("431")
    expect(n!.headline).toContain("500")
    expect(n!.detail).toMatch(/unknown cost — not free/i)
  })

  it("is SUPPRESSED when every purchase in the window was priced", () => {
    // The normal state now that only verified purchases are counted. A standing
    // caveat here would cry wolf on a complete figure.
    expect(spendCoverageNotice(totals(), coverage())).toBeNull()
  })

  it("is suppressed on an empty window rather than dividing by zero", () => {
    const n = spendCoverageNotice(
      totals({ purchases: 0, priced_purchases: 0, spend_usd: 0 }),
      coverage({ unpriced_purchases: 0 })
    )
    expect(n).toBeNull()
  })
})

describe("observationNotice", () => {
  it("qualifies 'all time' as 'all TRACKED time'", () => {
    const n = observationNotice("all", coverage())
    expect(n).toContain("2026-06-09")
    expect(n).toMatch(/not the programme's full history/i)
  })

  it("is absent on bounded windows, whose range is already stated", () => {
    expect(observationNotice("week", coverage())).toBeNull()
    expect(observationNotice("month", coverage())).toBeNull()
    expect(observationNotice("year", coverage())).toBeNull()
  })

  it("is absent when we do not know when observation started", () => {
    expect(observationNotice("all", coverage({ observation_start: null }))).toBeNull()
  })
})

describe("formatters distinguish absent from zero", () => {
  it("formatUsd renders an em-dash for null/undefined but $0.00 for a real zero", () => {
    expect(formatUsd(null)).toBe(NO_FIGURE)
    expect(formatUsd(undefined)).toBe(NO_FIGURE)
    expect(formatUsd(Number.NaN)).toBe(NO_FIGURE)
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(190)).toBe("$190.00")
    expect(formatUsd(10081.93)).toBe("$10.1k")
    expect(formatUsd(2_500_000)).toBe("$2.50M")
  })

  it("formatCount renders an em-dash for null but 0 for a real zero", () => {
    expect(formatCount(null)).toBe(NO_FIGURE)
    expect(formatCount(0)).toBe("0")
    expect(formatCount(161366)).toBe("161,366")
  })
})

describe("walletLabel", () => {
  it("prefers a resolved username", () => {
    expect(walletLabel("0xe1f2a091f7bb5245", "TopShot_Buyback_2")).toBe("TopShot_Buyback_2")
  })

  it("truncates an unresolved address rather than showing nothing", () => {
    expect(walletLabel("0x4d2c9216f1dca098", null)).toBe("0x4d2c…a098")
    expect(walletLabel("0x4d2c9216f1dca098", "   ")).toBe("0x4d2c…a098")
  })

  it("leaves a short address intact", () => {
    expect(walletLabel("0xabc", null)).toBe("0xabc")
  })
})
