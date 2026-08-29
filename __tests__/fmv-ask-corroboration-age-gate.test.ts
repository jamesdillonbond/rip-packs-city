import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  escalateConfidence,
  MAX_ASK_AGE_HOURS_CORROBORATION,
  MIN_SALES_ASK_CORROBORATION,
} from "@/lib/fmv-confidence"
import { ASK_STALE_HOURS } from "@/lib/market/ask-freshness"

// ── An ask nobody has confirmed in three months is not corroboration ────────
//
// 🚨 WHY THIS EXISTS (2026-08-29). `escalateConfidence` lifts an edition LOW → MEDIUM
// when "an independent LIVE ask" agrees with the sales median — and had NO age bound
// at all. `edition_offers` holds Top Shot rows up to 87 days old (83 of them over 30
// days), every one able to make that promotion. MEDIUM is not cosmetic: it is what
// gates the public Below-FMV board, so a dead ask could inject a row onto a board
// whose per-row staleness markers only exist downstream of this decision.
//
// ⚠⚠ THE THRESHOLD IS SEVEN DAYS, NOT TWELVE HOURS, AND THAT IS THE WHOLE FINDING.
// The obvious fix is to reuse the boards' `ASK_STALE_HOURS` (12 h). Measured first,
// during the offers-sweep outage: of 12,259 Top Shot asks, **12,121 (98.9%) were older
// than 12 h**, versus 168 (1.4%) older than 3 days, 155 (1.3%) older than 7 and 83
// (0.7%) older than 30. A 12 h gate would have demoted essentially the entire
// catalogue out of MEDIUM — emptying the deals board — over a transient upstream
// failure. ⭐ The two constants answer DIFFERENT questions and unifying them is the
// bug: the display marker says *look before you act*, the pricing gate says *this is
// no longer evidence*.

const TIGHT = [100, 100, 100, 100]

describe("ask-corroboration is bounded by the ask's age", () => {
  it("is not vacuous: corroboration still works on a recent ask", () => {
    // Without this, every assertion below would pass on a function that never
    // corroborates at all.
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, 1)).toBe("MEDIUM")
  })

  it("an ask older than the bound does NOT corroborate", () => {
    expect(
      escalateConfidence("LOW", 4, TIGHT, undefined, 100, MAX_ASK_AGE_HOURS_CORROBORATION + 1),
      "a months-old ask lifted an edition to MEDIUM and onto the public deals board",
    ).toBe("LOW")
    // The population that motivated it: an 87-day-old row.
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, 87 * 24)).toBe("LOW")
  })

  it("the boundary is inclusive-exclusive at exactly the bound", () => {
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, MAX_ASK_AGE_HOURS_CORROBORATION - 1)).toBe("MEDIUM")
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, MAX_ASK_AGE_HOURS_CORROBORATION)).toBe("LOW")
  })

  it("🚨 an UNDATABLE ask does not corroborate — 'I could not tell' is not 'recent'", () => {
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, null)).toBe("LOW")
  })

  it("CONTROL — an age-unaware caller (age omitted) keeps the pre-gate behaviour", () => {
    // The legacy path. Passing no age at all must not silently disable a feature for
    // callers that were never changed.
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100)).toBe("MEDIUM")
  })

  it("CONTROL — the gate only ever WITHHOLDS a lift, it never demotes on its own", () => {
    // The ask is a floor: corroboration may raise, never lower. An ancient ask must
    // not drag a MEDIUM or HIGH edition down.
    expect(escalateConfidence("MEDIUM", 7, TIGHT, undefined, 100, 99 * 24)).toBe("MEDIUM")
    const tight7 = [100, 100, 100, 100, 100, 100, 100]
    expect(escalateConfidence("MEDIUM", 7, tight7, undefined, 5, 99 * 24)).toBe("HIGH")
  })

  it("CONTROL — a fresh ask that DISAGREES still does not corroborate", () => {
    // The age gate must not have replaced the band check.
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 1000, 1)).toBe("LOW")
  })

  it("CONTROL — the sales-count floor still applies to a fresh ask", () => {
    expect(
      escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION - 1, [100, 100], undefined, 100, 1),
    ).toBe("LOW")
  })

  it("🚨 the pricing bound is FAR looser than the display marker, and deliberately so", () => {
    // If someone later "tidies up" by pointing the corroboration at ASK_STALE_HOURS,
    // this reds and the comment explains why. 98.9% of the catalogue sat between the
    // two on the day it was written.
    expect(
      MAX_ASK_AGE_HOURS_CORROBORATION,
      "the pricing gate was unified with the 12h display marker — that demotes ~99% of " +
        "the catalogue during any upstream outage",
    ).toBeGreaterThan(ASK_STALE_HOURS * 4)
    // ...and still bounded: an ask this old is not evidence at any threshold.
    expect(MAX_ASK_AGE_HOURS_CORROBORATION).toBeLessThan(30 * 24)
  })
})

// The gate is inert unless the one caller that passes an ask also passes its age.
describe("fmv-recalc supplies the ask age", () => {
  const src = readFileSync(
    path.join(path.resolve(__dirname, ".."), "app/api/fmv-recalc/route.ts"),
    "utf8",
  )

  it("is not vacuous: the route still fetches asks and calls escalateConfidence", () => {
    expect(src).toContain("escalateConfidence(")
    expect(src).toContain('.from("edition_offers")')
  })

  it("selects updated_at, so the age is knowable at all", () => {
    // Without this column the route CANNOT date an ask, and the gate would silently
    // fall through to the legacy path on every edition.
    expect(src).toMatch(/\.select\("external_id, low_ask, updated_at"\)/)
  })

  it("passes the age to escalateConfidence, so the legacy path is not production", () => {
    expect(src).toContain("editionAskAgeHoursById.get(editionId) ?? null")
  })
})
