import { describe, it, expect } from "vitest"
import {
  topshotSeriesLabel,
  seriesLabel,
  isUnmappedSeriesLabel,
} from "@/lib/analytics/series-labels"

// Series-label derivation for analytics rollups. Series 1 does not exist
// on-chain (Series 0 IS Series 1), so 1 and null both bucket to Misc/Unmapped.

describe("topshotSeriesLabel", () => {
  it("buckets null and the non-existent series 1 as Misc / Unmapped", () => {
    expect(topshotSeriesLabel(null)).toBe("Misc / Unmapped")
    expect(topshotSeriesLabel(undefined)).toBe("Misc / Unmapped")
    expect(topshotSeriesLabel(1)).toBe("Misc / Unmapped")
  })

  it("maps a known series and falls back to 'Series N' for unknown ints", () => {
    expect(topshotSeriesLabel(0)).not.toBe("Misc / Unmapped") // Series 0 is real
    expect(topshotSeriesLabel(99)).toBe("Series 99")
  })
})

describe("seriesLabel", () => {
  it("routes topshot through the topshot mapping", () => {
    expect(seriesLabel("topshot", 1)).toBe("Misc / Unmapped")
    expect(seriesLabel("TopShot", 99)).toBe("Series 99")
  })
  it("other collections: 'Series N' or Misc when null", () => {
    expect(seriesLabel("allday", 3)).toBe("Series 3")
    expect(seriesLabel("allday", null)).toBe("Misc / Unmapped")
  })
})

describe("isUnmappedSeriesLabel", () => {
  it("detects the Misc / Unmapped bucket", () => {
    expect(isUnmappedSeriesLabel("Misc / Unmapped")).toBe(true)
    expect(isUnmappedSeriesLabel("Series 3")).toBe(false)
  })
})
