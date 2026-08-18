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

  // ── BOTH label conventions must resolve (2026-08-18) ────────────────────
  //
  // Top Shot carries two live spellings for on-chain series 6/7/8:
  // collection_series.display_label says "Series 5/6/7" (this is what the
  // Collection tab's own filter control is built from), the repo constants say
  // "Series 2023-24/2024-25/2025-26". A persisted filter value can arrive in
  // either spelling.
  //
  // This matters precisely when the dynamic options are EMPTY — which is a real
  // state, not a hypothetical: CollectionTabClient's options fetch swallows a
  // failed read. Before the fix, the DB spellings were absent from the fallback,
  // so the resolver returned null, the caller left `series` unset, and the user
  // was shown the FULL catalogue with the filter still displayed as active.
  it("resolves the collection_series display labels for 6/7/8 with NO dynamic options", () => {
    expect(resolveSeriesParam("Series 5", [])).toBe("6")
    expect(resolveSeriesParam("Series 6", [])).toBe("7")
    expect(resolveSeriesParam("Series 7", [])).toBe("8")
  })

  it("resolves BOTH spellings of 6/7/8 to the SAME on-chain number", () => {
    // The property, not the spelling: whichever convention the product settles
    // on, the two must never disagree about which series a label means.
    expect(resolveSeriesParam("Series 5", [])).toBe(resolveSeriesParam("Series 2023-24", []))
    expect(resolveSeriesParam("Series 6", [])).toBe(resolveSeriesParam("Series 2024-25", []))
    expect(resolveSeriesParam("Series 7", [])).toBe(resolveSeriesParam("Series 2025-26", []))
  })

  it("the two conventions do not collide — every fallback label has exactly one meaning", () => {
    // The fact that makes one flat map safe. If a future edit introduces a label
    // that means different series under the two conventions, this reds.
    const labels = [
      "Series 1", "Series 2", "Summer 2021", "Series 3", "Series 4",
      "Series 2023-24", "Series 2024-25", "Series 2025-26",
      "Series 5", "Series 6", "Series 7",
    ]
    const resolved = labels.map((l) => resolveSeriesParam(l, []))
    // Every label resolves (no silent null → dropped filter)...
    expect(resolved.filter((r) => r === null)).toEqual([])
    // ...and the agreeing half still maps where it always did.
    expect(resolveSeriesParam("Series 1", [])).toBe("0")
  })

  it("the dynamic option wins even when the label also exists in the fallback map", () => {
    // A dynamic option remapping "Series 1" to a different number must win.
    expect(resolveSeriesParam("Series 1", [{ label: "Series 1", seriesNumber: 99 }])).toBe("99")
  })

  it("returns null for an unknown label (caller leaves the param unset)", () => {
    expect(resolveSeriesParam("Series 999", opts)).toBeNull()
    expect(resolveSeriesParam("", opts)).toBeNull()
  })

  it("returns null for a prototype-name label (no leaked Object.prototype member)", () => {
    // label is externally controlled (localStorage/URL filter). A crafted key
    // must fall to null, not resolve a truthy Object.prototype function and
    // stamp it into the `series` query param.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(resolveSeriesParam(key, opts)).toBeNull()
    }
  })
})
