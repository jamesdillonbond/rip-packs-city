import { describe, it, expect } from "vitest"
import {
  isFmvPhantom,
  applyPhantomGuard,
  applyStaleGuard,
  applyAllFmvGuards,
  capFmvAtCheapestAsk,
} from "@/lib/fmv-phantom-guard"

// Source-side mirror of the fmv_snapshots phantom + thin-sales triggers. These
// stop absurd FMVs ($500k on a LOW/no-sales edition) and unbacked high prices
// from being written. Cases mirror the ones documented in the module header.

describe("isFmvPhantom", () => {
  it("legit high-value HIGH row with sales is not phantom", () => {
    expect(isFmvPhantom({ fmv_usd: 15000, confidence: "HIGH", sales_count_30d: 3 })).toBe(false)
  })
  it("under $10k is never phantom", () => {
    expect(isFmvPhantom({ fmv_usd: 50, confidence: "LOW", sales_count_30d: 0 })).toBe(false)
  })
  it(">$10k LOW/no-sales is phantom", () => {
    expect(isFmvPhantom({ fmv_usd: 500000, confidence: "LOW", sales_count_30d: 0 })).toBe(true)
  })
  it(">$10k HIGH but <3 sales is phantom", () => {
    expect(isFmvPhantom({ fmv_usd: 15000, confidence: "HIGH", sales_count_30d: 2 })).toBe(true)
  })
  it("null fmv is not phantom", () => {
    expect(isFmvPhantom({ fmv_usd: null, confidence: "LOW", sales_count_30d: 0 })).toBe(false)
  })
})

describe("applyPhantomGuard", () => {
  it("nulls fmv/asp/floor on a phantom row, preserving other fields", () => {
    const out = applyPhantomGuard({
      edition_id: "e1",
      fmv_usd: 500000,
      asp_usd: 490000,
      floor_price_usd: 480000,
      confidence: "LOW",
      sales_count_30d: 0,
    })
    expect(out.fmv_usd).toBeNull()
    expect(out.asp_usd).toBeNull()
    expect(out.floor_price_usd).toBeNull()
    expect(out.edition_id).toBe("e1")
  })

  it("leaves a legitimate row untouched", () => {
    const row = { fmv_usd: 50, confidence: "HIGH", sales_count_30d: 5 }
    expect(applyPhantomGuard(row)).toBe(row)
  })
})

describe("applyStaleGuard", () => {
  it("marks a >$200 no-sales LOW row STALE", () => {
    expect(applyStaleGuard({ fmv_usd: 250, sales_count_30d: 0, confidence: "LOW" }).confidence).toBe("STALE")
  })
  it("leaves a still-trading row unchanged", () => {
    const row = { fmv_usd: 250, sales_count_30d: 5, confidence: "MEDIUM" }
    expect(applyStaleGuard(row)).toBe(row)
  })
  it("leaves an under-threshold row unchanged", () => {
    const row = { fmv_usd: 50, sales_count_30d: 0, confidence: "LOW" }
    expect(applyStaleGuard(row)).toBe(row)
  })
  it("never downgrades HIGH (caller already broke an invariant)", () => {
    const row = { fmv_usd: 250, sales_count_30d: 0, confidence: "HIGH" }
    expect(applyStaleGuard(row)).toBe(row)
  })
  it("exempts ASK_ONLY (honest ask-derived label)", () => {
    const row = { fmv_usd: 850, sales_count_30d: 0, confidence: "ASK_ONLY" }
    expect(applyStaleGuard(row)).toBe(row)
  })
})

describe("applyAllFmvGuards", () => {
  it("composes both guards (phantom nulling wins on an absurd row)", () => {
    const out = applyAllFmvGuards({
      edition_id: "e2",
      fmv_usd: 500000,
      asp_usd: 1,
      floor_price_usd: 1,
      sales_count_30d: 0,
      confidence: "LOW",
    })
    expect(out.fmv_usd).toBeNull()
  })

  it("applies the stale guard when the row is not phantom but is thin", () => {
    const out = applyAllFmvGuards({ fmv_usd: 250, sales_count_30d: 0, confidence: "LOW" })
    expect(out.fmv_usd).toBe(250)
    expect(out.confidence).toBe("STALE")
  })
})

describe("capFmvAtCheapestAsk (ask-ceiling for non-special-serial FMV)", () => {
  it("caps an overstated base FMV down to the cheapest ask", () => {
    // The real 2026 case: edition read $45.83 FMV vs a $23 floor ask.
    expect(capFmvAtCheapestAsk(45.83, 23)).toBe(23)
  })
  it("leaves an FMV already at/under the ask unchanged", () => {
    expect(capFmvAtCheapestAsk(20, 23)).toBe(20)
    expect(capFmvAtCheapestAsk(23, 23)).toBe(23)
  })
  it("does not cap when there is no ask feed", () => {
    expect(capFmvAtCheapestAsk(45.83, null)).toBe(45.83)
    expect(capFmvAtCheapestAsk(45.83, undefined)).toBe(45.83)
  })
  it("ignores a non-positive or non-finite ask", () => {
    expect(capFmvAtCheapestAsk(45.83, 0)).toBe(45.83)
    expect(capFmvAtCheapestAsk(45.83, -5)).toBe(45.83)
    expect(capFmvAtCheapestAsk(45.83, Number.NaN)).toBe(45.83)
  })
  it("is a pure min (never raises the FMV toward a higher ask)", () => {
    expect(capFmvAtCheapestAsk(10, 999)).toBe(10)
  })
})
