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
import { fmvBasis, isAskDerivedFmv, isSalesCappedAlgo, askCapFlag, priceRuleNotes } from "@/lib/fmv-basis"

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

  // 2026-11-12: the All Day comp cap (`_compcap`) holds an ask-only price to the edition's comparable
  // estimate. That number is neither one seller's ask nor the edition's own sales, so BOTH older
  // markers would be false about it.
  it("⛔ a price held to comparables wears neither 'from asks' nor 'capped at sales'", () => {
    const b = fmvBasis("ASK_ONLY", "comparables")!
    expect(b.label).toBe("held to comparables")
    expect(`${b.label} ${b.title}`).not.toMatch(/from asks|no corroborating sales|capped at sales|its own sales/i)
    for (const banned of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", "NO_DATA", "confidence"]) {
      expect(`${b.label} ${b.title}`, banned).not.toContain(banned)
    }
    expect(fmvBasis("HIGH", "comparables")).toBeNull()
  })

  it("askCapFlag: the LAST cap decides — sales wins over comparables, as in get_edition_detail", () => {
    expect(askCapFlag("allday-listing-ask-v1_compcap")).toBe("comparables")
    expect(askCapFlag("allday-listing-ask-v1_compcap_bidfloor")).toBe("comparables")
    // the comp cap fires before the sales cap, so a row both touched ends _salescap → sales
    expect(askCapFlag("allday-listing-ask-v1_compcap_salescap")).toBe(true)
    expect(askCapFlag("1.8.3_salescap_bidfloor")).toBe(true)
    expect(askCapFlag("cold-tail-1.0_bidfloor")).toBe(false)
    expect(askCapFlag("compcap_v2")).toBe(false)
    expect(askCapFlag(null)).toBe(false)
    expect(askCapFlag(undefined)).toBe(false)
  })

  // 2026-11-12 (evening): the Top Shot offer pull (`_bidpull`) moves an ask-only price between the best
  // open offer and the ask. No older marker is true of it: it is not the seller's ask, not the edition's
  // sales, not its set-mates.
  it("⛔ a price moved toward the best offer wears none of the three older markers", () => {
    const b = fmvBasis("ASK_ONLY", "offers")!
    expect(b.label).toBe("between offer and ask")
    expect(b.label).not.toMatch(/from asks|capped at sales|held to comparables/i)
    expect(b.title).toMatch(/open offer/i)
    expect(b.title).not.toMatch(/what one seller is asking|held to its own sales|similar editions/i)
    for (const banned of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", "NO_DATA", "confidence"]) {
      expect(`${b.label} ${b.title}`, banned).not.toContain(banned)
    }
    // a sale-backed price the pull also moved carries no marker at all
    expect(fmvBasis("LOW", "offers")).toBeNull()
  })

  it("askCapFlag: _bidpull is always last and wins, as in get_edition_detail's basis_offer", () => {
    expect(askCapFlag("1.8.3_bidpull")).toBe("offers")
    expect(askCapFlag("cold-tail-1.0_histcap_bidpull")).toBe("offers")
    expect(askCapFlag("topshot-gql-v1_stalecap_bidpull")).toBe("offers")
    // the offer FLOOR (bid above the price) is a different rule and keeps its old reading
    expect(askCapFlag("1.8.3_histcap_bidfloor")).toBe(true)
    expect(askCapFlag("cold-tail-1.0_bidfloor")).toBe(false)
    expect(askCapFlag("bidpull_v2")).toBe(false)
    // a never-sold Top Shot edition: pulled, THEN held to its comparable estimate → comparables
    expect(askCapFlag("1.8.3_bidpull_compcap")).toBe("comparables")
    expect(askCapFlag("topshot-gql-v1_compcap")).toBe("comparables")
  })

  it("isSalesCappedAlgo reads the same suffixes as get_edition_detail's basis_capped", () => {
    expect(isSalesCappedAlgo("1.8.3_salescap")).toBe(true)
    expect(isSalesCappedAlgo("cold-tail-1.0_histcap")).toBe(true)
    expect(isSalesCappedAlgo("1.8.3")).toBe(false)
    expect(isSalesCappedAlgo("salescap_v2")).toBe(false)
    // 2026-11-04: the Top Shot offer floor appends _bidfloor after the cap — still capped; an uncapped bid-floored ask is not.
    expect(isSalesCappedAlgo("1.8.3_salescap_bidfloor")).toBe(true)
    expect(isSalesCappedAlgo("cold-tail-1.0_histcap_salescap_bidfloor")).toBe(true)
    expect(isSalesCappedAlgo("cold-tail-1.0_bidfloor")).toBe(false)
    expect(isSalesCappedAlgo("1.8.3_salescap_haircut")).toBe(false)
    expect(isSalesCappedAlgo(null)).toBe(false)
    expect(isSalesCappedAlgo(undefined)).toBe(false)
  })

  it("priceRuleNotes: plain words for each rule, in the order applied, and nothing internal", () => {
    expect(priceRuleNotes("1.8.3")).toEqual([])
    expect(priceRuleNotes(null)).toEqual([])
    expect(priceRuleNotes("thin-sales-guard-v3")).toEqual([])
    const pulled = priceRuleNotes("cold-tail-1.0_histcap_bidpull")
    expect(pulled).toHaveLength(2)
    expect(pulled[0]).toMatch(/actually sold for/)
    expect(pulled[1]).toMatch(/best open offer/)
    const unsold = priceRuleNotes("topshot-gql-v1_bidpull_compcap")
    expect(unsold.map((n) => /similar editions/.test(n))).toEqual([false, true])
    expect(priceRuleNotes("1.8.3_haircut_bidfloor").join(" | ")).toMatch(/discounted.*\|.*lifted to the best open offer/)
    for (const algo of ["1.8.3_salescap_bidfloor", "x_stalecap", "panini-1.4.1_askcap", "a_compcap", "a_bidpull", "a_haircut"]) {
      const text = priceRuleNotes(algo).join(" ")
      expect(text.length, algo).toBeGreaterThan(0)
      for (const banned of ["HIGH", "MEDIUM", "LOW", "STALE", "ASK_ONLY", "confidence", "_bid", "_comp", "cap_", "algo"]) {
        expect(text, `${algo}: ${banned}`).not.toContain(banned)
      }
    }
  })

  it("isAskDerivedFmv mirrors fmvBasis as a boolean", () => {
    expect(isAskDerivedFmv("ASK_ONLY")).toBe(true)
    expect(isAskDerivedFmv("HIGH")).toBe(false)
    expect(isAskDerivedFmv(null)).toBe(false)
  })
})

// 2026-11-13: a never-sold Top Shot hold that the standing offer stopped is tagged `_compcap_bidfloor` (20261113233615),
// so it reads as "held to comparables" + "lifted to the best open offer", never "between offer and ask".
describe("a comparables hold stopped at the offer (Top Shot step 2)", () => {
  it("reads as comparables, with or without the pull before it", () => {
    expect(askCapFlag("v2_compcap_bidfloor")).toBe("comparables")
    expect(askCapFlag("v2_bidpull_compcap_bidfloor")).toBe("comparables")
    expect(fmvBasis("ASK_ONLY", askCapFlag("v2_bidpull_compcap_bidfloor"))?.label).toBe("held to comparables")
  })
  it("its notes name the comparables hold and the offer, in order", () => {
    const n = priceRuleNotes("v2_compcap_bidfloor")
    expect(n).toHaveLength(2)
    expect(n[0]).toMatch(/similar editions/)
    expect(n[1]).toMatch(/best open offer/)
  })
})
