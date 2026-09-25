import { describe, it, expect } from "vitest"
import { seriesLabel, seriesDisplay, seriesPageLabel, tileSeriesLabel, SERIES_DISPLAY } from "@/lib/series-label"
import { SERIES_FILTER_LABEL_FALLBACK } from "@/lib/collection/helpers"

// The load-bearing quirk: on-chain series 0 = "Series 1" (there is no on-chain
// series 1). A regression relabels every edition's era.

describe("seriesLabel — analytics-board variant", () => {
  it("0 = Series 1 (the quirk), and the numbered/season labels (unified 'Series' prefix)", () => {
    expect(seriesLabel(0)).toBe("Series 1")
    expect(seriesLabel(2)).toBe("Series 2")
    expect(seriesLabel(3)).toBe("Summer 2021")
    expect(seriesLabel(4)).toBe("Series 3")
    expect(seriesLabel(5)).toBe("Series 4")
    expect(seriesLabel(6)).toBe("Series 2023-24")
    expect(seriesLabel(7)).toBe("Series 2024-25")
    expect(seriesLabel(8)).toBe("Series 2025-26")
  })
  it("null/undefined/unknown → Unknown (note: NO on-chain series 1)", () => {
    expect(seriesLabel(null)).toBe("Unknown")
    expect(seriesLabel(undefined)).toBe("Unknown")
    expect(seriesLabel(1)).toBe("Unknown")
    expect(seriesLabel(99)).toBe("Unknown")
  })
})

describe("seriesDisplay — moment-page variant (Top Shot only)", () => {
  it("Top Shot decodes via SERIES_DISPLAY (0 = Series 1)", () => {
    expect(seriesDisplay(0, "nba_top_shot")).toBe("Series 1")
    expect(seriesDisplay(6, "nba-top-shot")).toBe("Series 2023-24")
  })
  it("Top Shot unknown n → 'Series N'", () => {
    expect(seriesDisplay(1, "nba_top_shot")).toBe("Series 1") // SERIES_DISPLAY[0] is the quirk; 1 is unmapped → "Series 1"
    expect(seriesDisplay(42, "nba_top_shot")).toBe("Series 42")
  })
  it("non-Top-Shot collections fall back to raw 'Series N'", () => {
    expect(seriesDisplay(6, "nfl_all_day")).toBe("Series 6")
    expect(seriesDisplay(0, null)).toBe("Series 0")
  })
})

describe("the two encoders now AGREE on every mapped series (unified 2026-07-27)", () => {
  it("seriesLabel === seriesDisplay(…, TopShot) for every mapped key", () => {
    for (const n of [0, 2, 3, 4, 5, 6, 7, 8]) {
      expect(seriesLabel(n)).toBe(seriesDisplay(n, "nba_top_shot"))
    }
  })
  it("series 6 is 'Series 2023-24' on both surfaces", () => {
    expect(seriesLabel(6)).toBe("Series 2023-24")
    expect(seriesDisplay(6, "nba_top_shot")).toBe("Series 2023-24")
  })
  it("SERIES_DISPLAY covers 0,2-8 (no key 1)", () => {
    expect(Object.keys(SERIES_DISPLAY).map(Number).sort((a, b) => a - b)).toEqual([0, 2, 3, 4, 5, 6, 7, 8])
  })
  it("fallbacks still legitimately differ: unmapped → Unknown (analytics) vs Series N (moment)", () => {
    expect(seriesLabel(99)).toBe("Unknown")
    expect(seriesDisplay(99, "nba_top_shot")).toBe("Series 99")
  })
})

describe("cross-surface consistency — the collection page's filter labels match", () => {
  // lib/collection/helpers.SERIES_FILTER_LABEL_FALLBACK feeds the collection
  // page's series filter chips. It already used the "Series 2023-24" form, so
  // after the 2026-07-27 analytics unify all THREE surfaces (analytics / moment /
  // collection) agree. Pin that equality here so a future edit to either map
  // reintroduces the inconsistency loudly instead of silently.
  it("SERIES_FILTER_LABEL_FALLBACK === the canonical SERIES_DISPLAY", () => {
    expect(SERIES_FILTER_LABEL_FALLBACK).toEqual(SERIES_DISPLAY)
  })
})

// 2026-09-24 — seriesPageLabel: the series PAGE (and every pill / filter that
// names a collection_series row) shows the site-wide Top Shot label, not the
// retired ordinal still stored in the DB. Other collections keep their label.
describe("seriesPageLabel", () => {
  it("Top Shot on-chain 6/7/8 → the season form the edition pages use", () => {
    expect(seriesPageLabel(8, "Series 7", "nba-top-shot")).toBe("Series 2025-26")
    expect(seriesPageLabel(6, "Series 5", "nba_top_shot")).toBe("Series 2023-24")
    expect(seriesPageLabel(0, "Series 1", "nba-top-shot")).toBe("Series 1")
    expect(seriesPageLabel(3, "Summer 2021", "nba-top-shot")).toBe("Summer 2021")
  })
  it("other collections and unmapped numbers keep the DB label", () => {
    expect(seriesPageLabel(7, "Series 7", "nfl-all-day")).toBe("Series 7")
    expect(seriesPageLabel(99, "Series 99", "nba-top-shot")).toBe("Series 99")
    expect(seriesPageLabel(null, null, "nba-top-shot")).toBe("Series")
  })
})

// 2026-09-24 — entity tiles: several RPCs emit the raw on-chain number as
// series_label; a bare integer is decoded, a phrase passes through.
describe("tileSeriesLabel", () => {
  it("decodes a bare integer with the Top Shot map, 'Series N' elsewhere", () => {
    expect(tileSeriesLabel("5", "nba-top-shot")).toBe("Series 4")
    expect(tileSeriesLabel("8", "nba-top-shot")).toBe("Series 2025-26")
    expect(tileSeriesLabel("3", "nfl-all-day")).toBe("Series 3")
  })
  it("passes phrases through and nulls empties", () => {
    expect(tileSeriesLabel("Series 2023-24", "nba-top-shot")).toBe("Series 2023-24")
    expect(tileSeriesLabel("2024 Season", "nfl-all-day")).toBe("2024 Season")
    expect(tileSeriesLabel("", "nba-top-shot")).toBeNull()
    expect(tileSeriesLabel(null, "nba-top-shot")).toBeNull()
  })
})
