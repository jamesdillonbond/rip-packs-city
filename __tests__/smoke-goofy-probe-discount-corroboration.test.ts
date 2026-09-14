import { describe, it, expect } from "vitest"
import { uncorroboratedDiscountClaims } from "@/app/api/smoke-test/route"

// ─────────────────────────────────────────────────────────────────────────────
// The Pinnacle Goofy concierge probe's discount check.
//
// ⚠ WHAT WAS WRONG. `fakeDiscount` was `/\d{2,3}\s*%\s*(?:below|off|under)/` —
// it fired on ANY percentage-under phrasing, and quoting ask-vs-FMV as a
// percentage is the deal-finding product. The probe failed EVERY concierge run
// on record (02:24, 09:10, 18:32 PT on 2026-09-13), always `fake discount on
// goofy`, while the answer was correct in every particular. `soft: true` is why
// nobody paid for it — and a permanently-red instrument is indistinguishable
// from a broken one at a glance.
//
// ⭐ THE PROPERTY PINNED HERE IS CORROBORATION, NOT MAGNITUDE. A discount claim
// is fabricated when the response's own printed figures do not produce it. That
// is the honest reading of what the check was added for (657ab80c6: a leaked
// Minnie FMV turning a $1 Goofy pin into "97% off").
//
// ⚠ THE FIRST CASE IS PRODUCTION TEXT, NOT A MOCK — it is the `body_excerpt`
// `smoke_test_results` captured for the 2026-09-14 01:32Z run that this probe
// failed, read back from the live database. A shape argument is what made the
// old check wrong; this is the measurement. (Truncated at 500 chars by the
// capture itself, so the last table row is cut — that is the stored text.)
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim from smoke_test_results, ran_at 2026-09-14 01:32:00.688+00. */
const PRODUCTION_ANSWER = [
  "Here are 8 Goofy pins currently listed under $50 — all very affordable:",
  "",
  "| Set | Tier | Ask | FMV | Discount |",
  "|---|---|---|---|---|",
  "| Mickey & Friends: Friends-Giving Vol.1 | Colored Enamel | $1 | $1.24 | 19% under |",
  "| Mickey & Friends: Surf's Up Vol.1 | Silver Sparkle | $1 | $1.28 | 22% under |",
  "| Mickey & Friends: Surf's Up Vol.1 | Standard | $1 | $1.12 | 11% under |",
  "| Disney Holiday Vol.1 | Colored Enamel | $1 | $0.90 | — (slight premium) |",
].join("\n")

describe("Goofy probe — a discount claim must be worked out from printed figures", () => {
  it("PASSES the real answer the old check failed on every run", () => {
    // Every row was verified against pinnacle_catalog by hand: 1/1.24 = 19% under,
    // 1/1.28 = 22%, 1/1.12 = 11%, and the one row trading ABOVE FMV is labelled a
    // premium rather than a discount. This is the surface working.
    expect(uncorroboratedDiscountClaims(PRODUCTION_ANSWER)).toEqual([])
  })

  it("asserts the ABSENCE of the false claim, not the presence of a message", () => {
    // The old body is one line long; pinning its behaviour keeps the regression
    // measurable instead of leaving it as folklore.
    const oldCheck = (t: string) => /\d{2,3}\s*%\s*(?:below|off|under)/.test(t.toLowerCase())
    expect(oldCheck(PRODUCTION_ANSWER)).toBe(true) // ← what made the probe permanently red
    expect(uncorroboratedDiscountClaims(PRODUCTION_ANSWER)).toEqual([])
  })

  it("FIRES on a percentage the row's own numbers do not produce", () => {
    const fabricated = "| Surf's Up Vol.1 | Standard | $1 | $1.12 | 60% under |"
    expect(uncorroboratedDiscountClaims(fabricated)).toEqual([60])
  })

  it("FIRES on a percentage with no figures anywhere in the response", () => {
    expect(uncorroboratedDiscountClaims("Goofy pins are 40% off right now.")).toEqual([40])
  })

  it("accepts prose restating a percentage the table corroborates", () => {
    // A summary sentence carries no figures of its own. Failing it would red the
    // probe for the same reason the old check did — the model showing its work.
    const withSummary = PRODUCTION_ANSWER + "\n\nThe best value is the Silver Sparkle at 22% under FMV."
    expect(uncorroboratedDiscountClaims(withSummary)).toEqual([])
  })

  it("does not fire on a premium, which states no discount at all", () => {
    expect(uncorroboratedDiscountClaims("| Disney Holiday Vol.1 | $1 | $0.90 | — (slight premium) |")).toEqual([])
  })

  it("leaves the ORIGINAL leak to fmvLeak, on purpose — it is self-consistent arithmetic", () => {
    // (29 − 1) / 29 = 96.6% → "97% off" is exactly what a leaked $29 Minnie FMV
    // produces, so a corroboration test cannot see it and must not pretend to.
    // The probe's `fmvLeak` branch ($2x/$3x beside fmv/discount/off/below) is the
    // instrument for that shape and is unchanged.
    const leak = "Goofy — Surf's Up Vol.1 — ask $1, FMV $29 — 97% off"
    expect(uncorroboratedDiscountClaims(leak)).toEqual([])
    const fmvLeakBranch = /\$2\d|\$3[0-5]/.test(leak.toLowerCase()) && /fmv|discount|\boff\b|below/.test(leak.toLowerCase())
    expect(fmvLeakBranch).toBe(true)
  })

  it("tolerates only rounding, not a made-up number", () => {
    // 1/1.24 is 19.35%: 19 and 20 are the same displayed figure, 23 is not.
    expect(uncorroboratedDiscountClaims("| $1 | $1.24 | 19% under |")).toEqual([])
    expect(uncorroboratedDiscountClaims("| $1 | $1.24 | 20% under |")).toEqual([])
    expect(uncorroboratedDiscountClaims("| $1 | $1.24 | 23% under |")).toEqual([23])
  })
})
