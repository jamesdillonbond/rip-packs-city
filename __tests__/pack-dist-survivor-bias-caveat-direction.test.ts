// 2026-10-20 live sweep: /nba-top-shot/pack/dist/1127 printed
// "Actual EV $1.73 · … EV inflated by survivor bias (pool 89% drawn) — honest value ≈
// secondary ask $6.00". Survivor bias only inflates EV, so a biased EV is a CEILING;
// pointing at a $6.00 ask as the "honest value" of a pack whose ceiling is $1.73
// tells the reader it is worth 3.5× what its own numbers support.
import { describe, it, expect } from "vitest"
import { survivorBiasCaveat } from "@/lib/pack-dist-verdict"

const fmtUsd = (n: number) => `$${n.toFixed(2)}`
const base = { depletionPct: 89.4, secondaryAvailable: true, secondaryAsk: 6, fmtUsd }

describe("survivorBiasCaveat", () => {
  it("never calls the ask the honest value when the biased EV is already below it (dist 1127)", () => {
    const s = survivorBiasCaveat({ ...base, grossEv: 1.73 })
    expect(s).not.toMatch(/honest value/)
    expect(s).toBe("EV inflated by survivor bias (pool 89% drawn) — a ceiling, already below the $6.00 ask")
  })

  it("keeps the ask as the honest value when the biased EV sits above it", () => {
    expect(survivorBiasCaveat({ ...base, grossEv: 24 })).toBe(
      "EV inflated by survivor bias (pool 89% drawn) — honest value ≈ secondary ask $6.00",
    )
  })

  it("says ceiling with no live ask, and does not invent a depletion figure", () => {
    expect(survivorBiasCaveat({ ...base, secondaryAvailable: false, grossEv: 1.73 })).toBe(
      "EV inflated by survivor bias (pool 89% drawn) — treat as a ceiling",
    )
    expect(survivorBiasCaveat({ ...base, depletionPct: null, secondaryAsk: 0, grossEv: 3 })).toBe(
      "EV inflated by survivor bias (pool heavily drawn) — treat as a ceiling",
    )
  })
})
