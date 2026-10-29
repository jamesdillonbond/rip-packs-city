// __tests__/fmv-basis.test.ts
//
// Pins lib/fmv-basis.ts — the ask-derived FMV disclosure shipped 2026-08-01.
//
// Two invariants are load-bearing and both directions matter:
//   1. ASK_ONLY  -> a marker, so a price that is 0.90 x one seller's ask on a
//      never-traded edition stops rendering identically to a sale-derived one.
//   2. everything else -> null, so the ~95% sale-derived majority stays unmarked.
// A regression in EITHER direction is a product bug: (1) restores the overclaim,
// (2) drowns the signal by marking every row.
//
// The third invariant is the standing no-confidence-UI policy: the returned copy
// must never contain the internal tier vocabulary (HIGH / MEDIUM / LOW / STALE /
// ASK_ONLY itself). That is asserted explicitly below, because the easiest way to
// "improve" this helper is to start emitting the enum.

import { describe, it, expect } from "vitest"
import { fmvBasis, isAskDerivedFmv, isSalesCappedAlgo } from "@/lib/fmv-basis"

describe("fmvBasis", () => {
  it("returns the ask-derived marker for ASK_ONLY, case- and whitespace-insensitively", () => {
    for (const c of ["ASK_ONLY", "ask_only", " Ask_Only "]) {
      const b = fmvBasis(c)
      expect(b, c).not.toBeNull()
      expect(b!.label).toBe("from asks")
      expect(b!.title.length).toBeGreaterThan(20)
    }
  })

  it("returns null for every sale-derived / no-data confidence, so the common case is unmarked", () => {
    for (const c of ["HIGH", "MEDIUM", "LOW", "NO_DATA", "SALES_ONLY", "STALE", "high", "unexpected_new_value"]) {
      expect(fmvBasis(c), c).toBeNull()
    }
  })

  it("returns null for null/undefined/empty, so an un-fetched confidence degrades to no claim", () => {
    expect(fmvBasis(null)).toBeNull()
    expect(fmvBasis(undefined)).toBeNull()
    expect(fmvBasis("")).toBeNull()
  })

  it("never leaks the internal confidence vocabulary into rendered copy", () => {
    const b = fmvBasis("ASK_ONLY")!
    const copy = `${b.label} ${b.title}`
    for (const banned of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", "NO_DATA", "confidence"]) {
      expect(copy, banned).not.toContain(banned)
    }
  })

  // #215 (2026-10-29): a capped ASK_ONLY price is the edition's sales, not the ask.
  it("⛔ a capped ASK_ONLY price never wears 'from asks — no corroborating sales'", () => {
    const b = fmvBasis("ASK_ONLY", true)!
    expect(b.label).toBe("capped at sales")
    expect(`${b.label} ${b.title}`).not.toMatch(/from asks|no corroborating sales/i)
    for (const banned of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", "NO_DATA", "confidence"]) {
      expect(`${b.label} ${b.title}`, banned).not.toContain(banned)
    }
  })

  it("the capped flag only matters on ASK_ONLY, and an absent flag keeps the ask marker", () => {
    expect(fmvBasis("HIGH", true)).toBeNull()
    expect(fmvBasis("ASK_ONLY", false)!.label).toBe("from asks")
    expect(fmvBasis("ASK_ONLY", null)!.label).toBe("from asks")
    expect(fmvBasis("ASK_ONLY")!.label).toBe("from asks")
  })

  it("isSalesCappedAlgo reads the same suffixes as get_edition_detail's basis_capped", () => {
    expect(isSalesCappedAlgo("1.8.3_salescap")).toBe(true)
    expect(isSalesCappedAlgo("cold-tail-1.0_histcap")).toBe(true)
    expect(isSalesCappedAlgo("1.8.3")).toBe(false)
    expect(isSalesCappedAlgo("salescap_v2")).toBe(false)
    expect(isSalesCappedAlgo(null)).toBe(false)
    expect(isSalesCappedAlgo(undefined)).toBe(false)
  })

  it("isAskDerivedFmv mirrors fmvBasis as a boolean", () => {
    expect(isAskDerivedFmv("ASK_ONLY")).toBe(true)
    expect(isAskDerivedFmv("HIGH")).toBe(false)
    expect(isAskDerivedFmv(null)).toBe(false)
  })
})
