import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  SPECIAL_SERIAL_MULTIPLIERS,
  TIER_EXPONENTS,
  computeFmv,
} from "../lib/market-compute"

// ── The homepage may not quote a multiplier the model does not implement ─────
//
// Deep-audit R105 (2026-09-18). `components/HomePageMarketing.tsx` published:
//
//   "Serial premium multipliers — 1-of-1 = 12×, low serials = 4.5×, last mint = 3×."
//
// Checked BOTH ways — as a claim about our model and as a claim about the market —
// two of the three failed:
//   · "1-of-1 = 12×"      ACCURATE. SPECIAL_SERIAL_MULTIPLIERS["#1 Serial"] === 12.
//   · "low serials = 4.5×" UNSUPPORTED. No such constant exists anywhere; low serials
//                          go through the continuous tier power law, and the live
//                          market median for that population was 1.00×.
//   · "last mint = 3×"     CONTRADICTED BY OUR OWN CODE. `computeSerialMultiplier`
//                          returns exactly 1.0 for any serial at or above the median,
//                          and the last mint is the MAXIMUM serial — so the model can
//                          never premium it. It returns 1.0×, not 3×.
//
// ⚠ This is the "never claim what the product lacks" rule failing on the
// highest-traffic public page, which is why it earns a ratchet rather than a fix.
//
// ⛔ DO NOT relax this by widening ALLOWED_MULTIPLIERS to "whatever the copy says".
// The direction of the pin is copy → code. If a number here has no home in
// lib/market-compute.ts, the copy is wrong, not this test.
//
// ⚠ Deliberately NOT asserted: that the multipliers are the RIGHT ones. The market
// says the model under-prices the last mint (observed ≈2.6× against 1.0× applied).
// That is a live FMV question and must be settled with measurement and a human
// decision, never by an autonomous retune. This guard only pins copy to code.

const SRC = readFileSync(
  join(process.cwd(), "components", "HomePageMarketing.tsx"),
  "utf8",
)

/** The bullet under test, located by its stable prefix rather than by line number. */
function serialPremiumBullet(): string {
  const line = SRC.split("\n").find(
    (l) => l.includes("copy:") && l.includes("Serial premium multipliers"),
  )
  if (!line) throw new Error("serial-premium bullet not found in HomePageMarketing.tsx")
  return line
}

/** Every `N×` or `N.N×` the bullet prints. */
function quotedMultipliers(line: string): number[] {
  return [...line.matchAll(/(\d+(?:\.\d+)?)\s*×/g)].map((m) => Number(m[1]))
}

describe("homepage serial-premium copy is pinned to the pricing model", () => {
  it("quotes at least one multiplier (the locator still finds the bullet)", () => {
    // Population control: if the bullet is reworded past the locator, every
    // assertion below would vacuously pass. This is what stops that.
    expect(quotedMultipliers(serialPremiumBullet()).length).toBeGreaterThan(0)
  })

  it("every multiplier it quotes is a real SPECIAL_SERIAL_MULTIPLIERS value", () => {
    const allowed = new Set(Object.values(SPECIAL_SERIAL_MULTIPLIERS))
    const quoted = quotedMultipliers(serialPremiumBullet())
    const unsupported = quoted.filter((n) => !allowed.has(n))
    expect({ quoted, allowed: [...allowed], unsupported }).toEqual({
      quoted,
      allowed: [...allowed],
      unsupported: [],
    })
  })

  it("NO-CHANGE CONTROL — the pre-R105 copy fails this guard", () => {
    // Without this, "assert nothing" and "assert the right thing" look identical.
    const legacy =
      '{ icon: "▲", copy: "Serial premium multipliers — 1-of-1 = 12×, low serials = 4.5×, last mint = 3×." },'
    const allowed = new Set(Object.values(SPECIAL_SERIAL_MULTIPLIERS))
    expect(quotedMultipliers(legacy).filter((n) => !allowed.has(n))).toEqual([4.5, 3])
  })

  it("makes no last-mint premium claim, because the model returns 1.0 there", () => {
    const line = serialPremiumBullet().toLowerCase()
    expect(line).not.toContain("last mint")
    expect(line).not.toContain("final mint")
    expect(line).not.toContain("highest serial")
  })

  it("the model itself still returns no premium at or above the median serial", () => {
    // The behavioural half of the claim above. If this ever goes green-to-red the
    // copy rule changes too — which is exactly when a human should look.
    const base = {
      momentId: "guard-r105",
      circulationCount: 100,
      tier: "Common" as const,
      lowAsk: 100,
    }
    const belowMedian = computeFmv({ ...base, serialNumber: 5 })
    const atMedian = computeFmv({ ...base, serialNumber: 50 })
    const lastMint = computeFmv({ ...base, serialNumber: 100 })
    expect(atMedian.serialMultiplier).toBe(1)
    expect(lastMint.serialMultiplier).toBe(1)
    expect(belowMedian.serialMultiplier).toBeGreaterThan(1)
  })

  it("the tier exponents the curve claim rests on are all negative", () => {
    // "a tier-calibrated curve for serials below an edition's median" is only
    // true while lower serial ⇒ higher premium, i.e. every exponent < 0.
    const values = Object.values(TIER_EXPONENTS)
    expect(values.length).toBeGreaterThan(0)
    expect(values.every((v) => v < 0)).toBe(true)
  })
})
