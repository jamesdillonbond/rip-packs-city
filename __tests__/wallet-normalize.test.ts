import { describe, it, expect } from "vitest"
import {
  normalizeSetName,
  normalizeParallel,
  normalizeSeries,
  buildEditionScopeKey,
} from "@/lib/wallet-normalize"

// Foundational normalizers feeding the FMV scope key (computeFmv builds its
// scopeKey from these). Drift here silently re-buckets moments — a "Base Set6"
// leak or an empty-parallel that isn't coerced to "Base" splits one edition's
// market signal across two keys.

describe("normalizeSetName", () => {
  it("collapses the 'Base Set6' data-quirk to 'Base Set'", () => {
    expect(normalizeSetName("Base Set6")).toBe("Base Set")
  })

  it("passes other names through and empties nullish", () => {
    expect(normalizeSetName("Cosmic")).toBe("Cosmic")
    expect(normalizeSetName(null)).toBe("")
    expect(normalizeSetName(undefined)).toBe("")
    expect(normalizeSetName("")).toBe("")
  })
})

describe("normalizeParallel", () => {
  it("coerces empty / whitespace / nullish to 'Base'", () => {
    expect(normalizeParallel(null)).toBe("Base")
    expect(normalizeParallel(undefined)).toBe("Base")
    expect(normalizeParallel("")).toBe("Base")
    expect(normalizeParallel("   ")).toBe("Base")
  })

  it("trims and preserves a named parallel", () => {
    expect(normalizeParallel("  Hexwave  ")).toBe("Hexwave")
  })
})

describe("normalizeSeries", () => {
  it("stringifies + trims, nullish → empty", () => {
    expect(normalizeSeries(4)).toBe("4")
    expect(normalizeSeries("  8 ")).toBe("8")
    expect(normalizeSeries(0)).toBe("0")
    expect(normalizeSeries(null)).toBe("")
    expect(normalizeSeries(undefined)).toBe("")
  })
})

describe("buildEditionScopeKey", () => {
  it("uses an explicit editionKey when present, joined to the parallel by '::'", () => {
    expect(
      buildEditionScopeKey({ editionKey: "73:2785", parallel: "Hexwave" })
    ).toBe("73:2785::Hexwave")
  })

  it("empty parallel resolves to '::Base'", () => {
    expect(buildEditionScopeKey({ editionKey: "73:2785" })).toBe("73:2785::Base")
  })

  it("falls back to setName-player when no editionKey", () => {
    expect(
      buildEditionScopeKey({ setName: "Base Set6", playerName: "Lillard" })
    ).toBe("Base Set-Lillard::Base")
  })

  it("uses 'unknown' when neither editionKey nor playerName given", () => {
    expect(buildEditionScopeKey({ setName: "Cosmic" })).toBe("Cosmic-unknown::Base")
  })

  it("falls back to subedition when parallel is absent", () => {
    expect(
      buildEditionScopeKey({ editionKey: "1:2", subedition: "Diced" })
    ).toBe("1:2::Diced")
  })
})
