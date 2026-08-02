// Pins the USD-formatter contract across lib/.
//
// `fmtUsd` was implemented ~10 times with divergent behaviour, so $1,500.50
// rendered as "$1,501" or "$1,500.50" depending on the surface. Three of those
// copies were also gated on `n >= 1000` rather than `Math.abs(n) >= 1000`, so a
// large NEGATIVE silently skipped the whole-dollar/grouped branch its positive
// twin took. This file pins (a) the canonical body, (b) that fix, and (c) the
// divergences that are deliberate — so a future consolidation has to be a
// conscious decision rather than an accident.

import { describe, it, expect } from "vitest"
import { fmtUsdWhole1000 } from "@/lib/usd-format"
import { fmtUsd as grailUsd } from "@/lib/grail-format"
import { fmtUsd as simUsd } from "@/lib/pack-simulator-math"
import { fmtUsd as dashSubUsd } from "@/lib/dashboard/format"
import { fmtUsd as dashUsd } from "@/lib/dashboard-format"
import { fmtUsd as marketUsd } from "@/lib/market-format"
import { fmtUsd as trophyUsd } from "@/lib/trophy-picker-format"
import { fmtUsd as analyticsUsd } from "@/lib/analytics/format"
import { fmtUsd as packDistUsd } from "@/lib/pack-dist-format"
import { fmtUsd as lifecycleUsd } from "@/lib/pack-lifecycle-format"

describe("fmtUsdWhole1000 — the canonical body", () => {
  it("em-dashes null / undefined / non-finite (never a fake $0)", () => {
    expect(fmtUsdWhole1000(null)).toBe("—")
    expect(fmtUsdWhole1000(undefined)).toBe("—")
    expect(fmtUsdWhole1000(NaN)).toBe("—")
    expect(fmtUsdWhole1000(Infinity)).toBe("—")
  })
  it("keeps cents below $1,000 and rounds to whole dollars at/above", () => {
    expect(fmtUsdWhole1000(0)).toBe("$0.00")
    expect(fmtUsdWhole1000(12.5)).toBe("$12.50")
    expect(fmtUsdWhole1000(999.99)).toBe("$999.99")
    expect(fmtUsdWhole1000(1000)).toBe("$1,000")
    expect(fmtUsdWhole1000(1500.6)).toBe("$1,501")
  })
  it("uses the |v| threshold so negatives get the same treatment (house $- form)", () => {
    expect(fmtUsdWhole1000(-1500.6)).toBe("$-1,501")
    expect(fmtUsdWhole1000(-12.5)).toBe("$-12.50")
  })
})

describe("consolidated copies are byte-identical to the canonical", () => {
  const cases = [null, undefined, NaN, 0, 0.004, 12.5, 999.99, 1000, 1500.6, -1500.6, -12.5]
  it("grail-format.fmtUsd === canonical", () => {
    for (const c of cases) expect(grailUsd(c as number)).toBe(fmtUsdWhole1000(c as number))
  })
  it("pack-simulator-math.fmtUsd === canonical", () => {
    for (const c of cases) expect(simUsd(c as number)).toBe(fmtUsdWhole1000(c as number))
  })
  it("dashboard/format.fmtUsd === canonical except the zero special-case", () => {
    expect(dashSubUsd(0)).toBe("$0")
    expect(dashSubUsd(-0)).toBe("$0")
    for (const c of cases.filter((c) => c !== 0)) {
      expect(dashSubUsd(c as number)).toBe(fmtUsdWhole1000(c as number))
    }
  })
})

// ── The Math.abs regression the consolidation surfaced ──────────────────────
describe("large negatives take the same branch as their positive twin", () => {
  it("dashboard-format", () => {
    expect(dashUsd(1500.6)).toBe("$1,501")
    expect(dashUsd(-1500.6)).toBe("$-1,501") // was "$-1500.60"
    expect(dashUsd(-12.5)).toBe("$-12.50")
    expect(dashUsd(0)).toBe("$0")
  })
  it("market-format", () => {
    expect(marketUsd(1500.6)).toBe("$1,501")
    expect(marketUsd(-1500.6)).toBe("$-1,501") // was "$-1,500.60"
    expect(marketUsd(-12.5)).toBe("$-12.50")
    expect(marketUsd(null)).toBe("—")
  })
  it("trophy-picker-format", () => {
    expect(trophyUsd(1500.6)).toBe("$1,501")
    expect(trophyUsd(-1500.6)).toBe("$-1,501") // was "$-1500.60"
    expect(trophyUsd(-12.5)).toBe("$-12.50")
    expect(trophyUsd(null)).toBe("—")
    expect(trophyUsd(0)).toBe("$0")
  })
})

// ── Deliberate divergences: NOT bugs, do not "unify" without a product call ──
describe("surfaces that deliberately keep a different convention", () => {
  it("analytics/format never rounds (always 2dp) and coerces null to $0.00", () => {
    expect(analyticsUsd(1500.6)).toBe("$1,500.60")
    expect(analyticsUsd(null as unknown as number)).toBe("$0.00")
  })
  it("pack-dist-format rounds at |v| >= 100, not 1000", () => {
    expect(packDistUsd(150.5)).toBe("$151")
    expect(packDistUsd(-250)).toBe("$-250")
    expect(packDistUsd(99.5)).toBe("$99.50")
  })
  it("pack-lifecycle-format drops decimals only for exact integers", () => {
    expect(lifecycleUsd(20)).toBe("$20")
    expect(lifecycleUsd(20.5)).toBe("$20.50")
    expect(lifecycleUsd(1500)).toBe("$1,500")
  })
  it("the $-prefixed negative form is the house convention, not a bug", () => {
    for (const f of [fmtUsdWhole1000, dashUsd, marketUsd, trophyUsd, packDistUsd]) {
      expect(f(-50 as never)).toMatch(/^\$-/)
    }
  })
})
