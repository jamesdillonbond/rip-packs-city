import { describe, it, expect } from "vitest"
import { resolveSeriesParam } from "@/lib/collection/series-param"

describe("resolveSeriesParam", () => {
  const opts = [
    { label: "Series 2024-25", seriesNumber: 7 },
    { label: "Series 2025-26", seriesNumber: 8 },
  ]

  it("prefers the dynamic collection options (label → seriesNumber as string)", () => {
    expect(resolveSeriesParam("Series 2024-25", opts)).toBe("7")
    expect(resolveSeriesParam("Series 2025-26", opts)).toBe("8")
  })

  it("falls back to the Top Shot hardcoded label map when no dynamic option matches", () => {
    expect(resolveSeriesParam("Series 1", [])).toBe("0")
    expect(resolveSeriesParam("Series 2", [])).toBe("2")
    expect(resolveSeriesParam("Summer 2021", [])).toBe("3")
    expect(resolveSeriesParam("Series 3", [])).toBe("4")
    expect(resolveSeriesParam("Series 4", [])).toBe("5")
    expect(resolveSeriesParam("Series 2023-24", [])).toBe("6")
  })

  it("the dynamic option wins even when the label also exists in the fallback map", () => {
    // A dynamic option remapping "Series 1" to a different number must win.
    expect(resolveSeriesParam("Series 1", [{ label: "Series 1", seriesNumber: 99 }])).toBe("99")
  })

  it("returns null for an unknown label (caller leaves the param unset)", () => {
    expect(resolveSeriesParam("Series 999", opts)).toBeNull()
    expect(resolveSeriesParam("", opts)).toBeNull()
  })
})
