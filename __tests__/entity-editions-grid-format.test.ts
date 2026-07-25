import { describe, it, expect } from "vitest"
import {
  type EditionSortKey,
  compareEditions,
  isTileVideoEnabled,
  partitionPackRows,
  exhaustedCount,
  buildLoadMoreUrl,
  buildEditionImageCandidates,
} from "@/lib/entity-editions-grid-format"

// Pins the pure sort / partition / URL / image-candidate logic lifted out of
// components/entity/EditionsGridPaginated.tsx (invisible to the coverage
// ratchet). A regression mis-sorts the tile grid, mis-partitions the pack-mode
// "exhausted" section, breaks Load-more paging, or drops the TS image fallback.

type Row = {
  route_slug: string
  fmv_usd: number | null
  circulation_count: number | null
  series_num?: number | null
  drop_weight?: number | null
}

const subjectOf = (e: Row) => e.route_slug

describe("compareEditions", () => {
  const a: Row = { route_slug: "b-play", fmv_usd: 10, circulation_count: 500, series_num: 4 }
  const b: Row = { route_slug: "a-play", fmv_usd: 40, circulation_count: 100, series_num: 8 }

  it("fmv_desc sorts by FMV descending", () => {
    expect(compareEditions(a, b, "fmv_desc", subjectOf)).toBeGreaterThan(0) // 40 - 10
    expect(compareEditions(b, a, "fmv_desc", subjectOf)).toBeLessThan(0)
  })
  it("fmv_desc treats null FMV as 0", () => {
    const nullFmv: Row = { route_slug: "z", fmv_usd: null, circulation_count: 1 }
    expect(compareEditions(nullFmv, a, "fmv_desc", subjectOf)).toBe(10) // 10 - 0
  })
  it("circ_asc sorts by circulation ascending", () => {
    expect(compareEditions(a, b, "circ_asc", subjectOf)).toBeGreaterThan(0) // 500 - 100
  })
  it("circ_asc sorts null circulation last (1e12 sentinel)", () => {
    const nullCirc: Row = { route_slug: "z", fmv_usd: 1, circulation_count: null }
    expect(compareEditions(nullCirc, a, "circ_asc", subjectOf)).toBeGreaterThan(0)
    expect(compareEditions(a, nullCirc, "circ_asc", subjectOf)).toBeLessThan(0)
  })
  it("series_desc sorts by series number descending, null as 0", () => {
    expect(compareEditions(a, b, "series_desc", subjectOf)).toBeGreaterThan(0) // 8 - 4
    const noSeries: Row = { route_slug: "z", fmv_usd: 1, circulation_count: 1 }
    expect(compareEditions(a, noSeries, "series_desc", subjectOf)).toBe(-4) // 0 - 4
  })
  it("alpha sorts by subject A→Z via subjectOf", () => {
    expect(compareEditions(a, b, "alpha", subjectOf)).toBeGreaterThan(0) // "b-play" > "a-play"
    expect(compareEditions(b, a, "alpha", subjectOf)).toBeLessThan(0)
  })
  it("drives a stable array sort for each key", () => {
    const rows: Row[] = [a, b, { route_slug: "c", fmv_usd: 25, circulation_count: 300, series_num: 6 }]
    const keys: EditionSortKey[] = ["fmv_desc", "circ_asc", "series_desc", "alpha"]
    for (const k of keys) {
      const sorted = [...rows].sort((x, y) => compareEditions(x, y, k, subjectOf))
      expect(sorted).toHaveLength(3)
    }
    const byFmv = [...rows].sort((x, y) => compareEditions(x, y, "fmv_desc", subjectOf))
    expect(byFmv.map((r) => r.fmv_usd)).toEqual([40, 25, 10])
  })
})

describe("isTileVideoEnabled", () => {
  it("true for the four collections with moment clips", () => {
    expect(isTileVideoEnabled("nba-top-shot")).toBe(true)
    expect(isTileVideoEnabled("nfl-all-day")).toBe(true)
    expect(isTileVideoEnabled("laliga-golazos")).toBe(true)
    expect(isTileVideoEnabled("ufc")).toBe(true)
  })
  it("false for Pinnacle and unknown slugs", () => {
    expect(isTileVideoEnabled("disney-pinnacle")).toBe(false)
    expect(isTileVideoEnabled("")).toBe(false)
    expect(isTileVideoEnabled("something-else")).toBe(false)
  })
})

describe("partitionPackRows", () => {
  const rows: Row[] = [
    { route_slug: "pull", fmv_usd: 1, circulation_count: 1, drop_weight: 5 },
    { route_slug: "gone", fmv_usd: 1, circulation_count: 1, drop_weight: 0 },
    { route_slug: "nodw", fmv_usd: 1, circulation_count: 1 }, // no drop_weight
  ]
  it("packMode off → all rows in grid, none exhausted", () => {
    const { gridRows, exhaustedRows } = partitionPackRows(rows, false)
    expect(gridRows).toEqual(rows)
    expect(exhaustedRows).toEqual([])
  })
  it("packMode on → drop_weight===0 exhausted; >0 and absent stay in grid", () => {
    const { gridRows, exhaustedRows } = partitionPackRows(rows, true)
    expect(gridRows.map((r) => r.route_slug)).toEqual(["pull", "nodw"])
    expect(exhaustedRows.map((r) => r.route_slug)).toEqual(["gone"])
  })
})

describe("exhaustedCount", () => {
  it("returns the larger of the server total and loaded count", () => {
    expect(exhaustedCount(50, 12)).toBe(50)
    expect(exhaustedCount(3, 12)).toBe(12)
    expect(exhaustedCount(0, 0)).toBe(0)
  })
})

describe("buildLoadMoreUrl", () => {
  it("uses ? when the base has no query string", () => {
    expect(buildLoadMoreUrl("/api/x", 20, 24)).toBe("/api/x?offset=20&limit=24")
  })
  it("uses & when the base already has a query string", () => {
    expect(buildLoadMoreUrl("/api/x?set=abc", 40, 24)).toBe("/api/x?set=abc&offset=40&limit=24")
  })
})

describe("buildEditionImageCandidates", () => {
  it("Top Shot + numeric rep_nft_id → media form first, then thumbnail", () => {
    const out = buildEditionImageCandidates(
      { rep_nft_id: "12345", thumbnail_url: "https://cdn.example/x.png" },
      "nba-top-shot",
    )
    expect(out).toEqual([
      "https://assets.nbatopshot.com/media/12345/image?width=400",
      "https://cdn.example/x.png",
    ])
  })
  it("Top Shot + non-numeric rep_nft_id → only the thumbnail", () => {
    const out = buildEditionImageCandidates(
      { rep_nft_id: "abc", thumbnail_url: "https://cdn.example/x.png" },
      "nba-top-shot",
    )
    expect(out).toEqual(["https://cdn.example/x.png"])
  })
  it("non-Top-Shot ignores rep_nft_id and uses the thumbnail", () => {
    const out = buildEditionImageCandidates(
      { rep_nft_id: "12345", thumbnail_url: "https://cdn.example/y.png" },
      "ufc",
    )
    expect(out).toEqual(["https://cdn.example/y.png"])
  })
  it("rewrites a slow ipfs.io thumbnail to the same-origin proxy", () => {
    const out = buildEditionImageCandidates(
      { rep_nft_id: null, thumbnail_url: "https://ipfs.io/ipfs/CID999" },
      "laliga-golazos",
    )
    expect(out).toEqual(["/api/public/ipfs-media/CID999"])
  })
  it("no thumbnail and no TS media → empty candidate list", () => {
    expect(buildEditionImageCandidates({ rep_nft_id: null, thumbnail_url: null }, "ufc")).toEqual([])
  })
})
