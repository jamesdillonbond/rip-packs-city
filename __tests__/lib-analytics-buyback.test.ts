import { describe, it, expect } from "vitest"

// Pure-logic tests for the buyback surface's honesty rules.
//
// Every case here exists because the naive implementation of the same thing is
// a false claim: `spend_usd ?? 0` renders 161,366 unpriced acquisitions as "$0
// spent", which is a statement about Top Shot's behaviour manufactured out of
// our own collection method. These assert the ABSENCE of the false claim, not
// merely the presence of a caveat.

import {
  formatCount,
  formatUsd,
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
  address: "0x4d2c9216f1dca098",
  username: "NBATopShotCommunity",
  acquisitions: 161366,
  priced_acquisitions: 0,
  spend_usd: null,
  distinct_editions: 1352,
  spend_known: false,
  ...over,
})

const totals = (over: Partial<BuybackTotals> = {}): BuybackTotals => ({
  acquisitions: 161797,
  priced_acquisitions: 431,
  spend_usd: 10081.93,
  spend_known: true,
  distinct_editions: 1482,
  active_days: 48,
  ...over,
})

const coverage = (over: Partial<BuybackCoverage> = {}): BuybackCoverage => ({
  observation_start: "2026-06-09",
  unpriced_acquisitions: 161366,
  unpriced_share_pct: 99.7,
  counterparty_known_for: 431,
  date_grain: "day",
  ...over,
})

describe("walletSpendDisplay", () => {
  it("an unpriced wallet reads as an em-dash, NEVER as $0", () => {
    const d = walletSpendDisplay(wallet())
    expect(d.known).toBe(false)
    expect(d.text).toBe(NO_FIGURE)
    // The whole point: the string "$0" must not appear anywhere in the output.
    expect(d.text).not.toMatch(/\$\s*0/)
    expect(d.note).toMatch(/no price is recorded/i)
  })

  it("a wallet whose spend is genuinely known renders the figure with no caveat", () => {
    const d = walletSpendDisplay(
      wallet({ spend_known: true, spend_usd: 10081.93, priced_acquisitions: 431 })
    )
    expect(d.known).toBe(true)
    expect(d.text).toBe("$10.1k")
    // A caveat on a complete figure would cry wolf on the system working.
    expect(d.note).toBeNull()
  })

  it("spend_known true but a null total still refuses to invent a number", () => {
    // Defensive: if the RPC ever reports known-with-null, an em-dash is right
    // and `$NaN` / `$0` are both wrong.
    const d = walletSpendDisplay(wallet({ spend_known: true, spend_usd: null }))
    expect(d.known).toBe(false)
    expect(d.text).toBe(NO_FIGURE)
  })
})

describe("spendCoverageNotice", () => {
  it("discloses the unpriced share when any acquisition is unpriced", () => {
    const n = spendCoverageNotice(totals(), coverage())
    expect(n).not.toBeNull()
    expect(n!.headline).toContain("431")
    expect(n!.headline).toContain("161,797")
    expect(n!.detail).toContain("99.7%")
    // It must say the acquisitions are real but unpriced — not that they were free.
    expect(n!.detail).toMatch(/unknown cost — not\s+free/i)
  })

  it("is SUPPRESSED when every acquisition in the window was priced", () => {
    // A permanent caveat is its own false claim: it tells a reader the number is
    // partial when it is complete.
    const n = spendCoverageNotice(
      totals({ acquisitions: 431, priced_acquisitions: 431 }),
      coverage({ unpriced_acquisitions: 0, unpriced_share_pct: 0 })
    )
    expect(n).toBeNull()
  })

  it("is suppressed on an empty window rather than dividing by zero", () => {
    const n = spendCoverageNotice(
      totals({ acquisitions: 0, priced_acquisitions: 0, spend_usd: 0 }),
      coverage({ unpriced_acquisitions: 0, unpriced_share_pct: null })
    )
    expect(n).toBeNull()
  })

  it("falls back to raw counts when the percentage is unavailable", () => {
    const n = spendCoverageNotice(totals(), coverage({ unpriced_share_pct: null }))
    expect(n!.detail).toContain("161,366")
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
    expect(walletLabel("0x4d2c9216f1dca098", "NBATopShotCommunity")).toBe("NBATopShotCommunity")
  })

  it("truncates an unresolved address rather than showing nothing", () => {
    expect(walletLabel("0x4d2c9216f1dca098", null)).toBe("0x4d2c…a098")
    expect(walletLabel("0x4d2c9216f1dca098", "   ")).toBe("0x4d2c…a098")
  })

  it("leaves a short address intact", () => {
    expect(walletLabel("0xabc", null)).toBe("0xabc")
  })
})
