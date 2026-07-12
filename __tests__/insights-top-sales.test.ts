import { describe, it, expect } from "vitest"
import {
  parseWindow,
  parseSort,
  TOP_SALES_VALID_COLLECTIONS,
} from "@/lib/insights/top-sales"

// The Top Sales / Whale Watch surface parses untrusted query params. Both the
// API route and the server page share these parsers so the query shape can't
// drift; pin the safe-default behavior so a bad ?window=/?sort= can never
// reach the DB query unvalidated.

describe("parseWindow", () => {
  it("accepts '30d' and defaults everything else to '7d'", () => {
    expect(parseWindow("30d")).toBe("30d")
    expect(parseWindow("7d")).toBe("7d")
    expect(parseWindow("90d")).toBe("7d")
    expect(parseWindow(null)).toBe("7d")
    expect(parseWindow(undefined)).toBe("7d")
    expect(parseWindow("'; DROP TABLE sales;--")).toBe("7d")
  })
})

describe("parseSort", () => {
  it("accepts 'recent' and defaults everything else to 'price'", () => {
    expect(parseSort("recent")).toBe("recent")
    expect(parseSort("price")).toBe("price")
    expect(parseSort("bogus")).toBe("price")
    expect(parseSort(null)).toBe("price")
    expect(parseSort(undefined)).toBe("price")
  })
})

describe("TOP_SALES_VALID_COLLECTIONS", () => {
  it("whitelists exactly the 5 published DB-slug collections", () => {
    expect([...TOP_SALES_VALID_COLLECTIONS].sort()).toEqual(
      [
        "nba_top_shot",
        "nfl_all_day",
        "laliga_golazos",
        "disney_pinnacle",
        "ufc_strike",
      ].sort()
    )
  })

  it("uses DB-slug (underscore) vocabulary, not URL slugs", () => {
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc_strike")).toBe(true)
    // URL-slug forms must NOT be members — they'd fail the CHECK-constrained query.
    expect(TOP_SALES_VALID_COLLECTIONS.has("ufc")).toBe(false)
    expect(TOP_SALES_VALID_COLLECTIONS.has("nba-top-shot")).toBe(false)
  })
})
