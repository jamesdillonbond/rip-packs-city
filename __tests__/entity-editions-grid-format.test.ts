import { describe, it, expect } from "vitest"
import {
  type EditionSortKey,
  compareEditions,
  isTileVideoEnabled,
  partitionPackRows,
  exhaustedCount,
  buildLoadMoreUrl,
  buildEditionImageCandidates,
  tsSizedMomentImage,
  GRID_TILE_IMAGE_WIDTH,
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
  // 2026-09-25 — Candy MLB's clips are arweave mp4. The tile is enabled ONLY
  // because proxy.ts's media-src allows both arweave.net and the *.arweave.net
  // host it redirects to; without them the CSP blocks every clip and the poster
  // hides the failure. Coupled here so neither half can change alone.
  it("Candy MLB video is enabled only while media-src allows both arweave hosts", async () => {
    const { readFileSync } = await import("node:fs")
    const proxySrc = readFileSync("proxy.ts", "utf8")
    const mediaSrc = proxySrc.match(/"media-src [^"]*"/)?.[0] ?? ""
    expect(isTileVideoEnabled("candy-mlb")).toBe(true)
    expect(mediaSrc).toContain("https://arweave.net")
    expect(mediaSrc).toContain("https://*.arweave.net")
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

  // IMAGE-WEIGHT REGRESSION (2026-07-25). The requested width must be caller
  // controlled: ~80% of TS editions store an IPFS master as thumbnail_url and the
  // IPFS gateways cannot resize, so the sized CDN derivative is the ONLY lever
  // between a 72px slot and a 4 MB download. Hardcoding 400 here re-introduces a
  // ~12× over-fetch on every small tile.
  it("honours a caller-supplied width instead of the 400 default", () => {
    const out = buildEditionImageCandidates(
      { rep_nft_id: "12345", thumbnail_url: "https://ipfs.io/ipfs/CID1" },
      "nba-top-shot",
      144,
    )
    expect(out).toEqual([
      "https://assets.nbatopshot.com/media/12345/image?width=144",
      "/api/public/ipfs-media/CID1",
    ])
  })
})

describe("tsSizedMomentImage", () => {
  it("builds a width-parameterised per-moment CDN URL for Top Shot", () => {
    expect(tsSizedMomentImage("nba-top-shot", "45663101", 144)).toBe(
      "https://assets.nbatopshot.com/media/45663101/image?width=144",
    )
  })
  it("rounds a fractional width so the URL never carries a decimal", () => {
    expect(tsSizedMomentImage("nba-top-shot", "1", 143.6)).toBe(
      "https://assets.nbatopshot.com/media/1/image?width=144",
    )
  })
  it("defaults to the grid tile width when none is supplied", () => {
    expect(tsSizedMomentImage("nba-top-shot", "1")).toBe(
      `https://assets.nbatopshot.com/media/1/image?width=${GRID_TILE_IMAGE_WIDTH}`,
    )
  })
  it("returns null for non-Top-Shot collections (no equivalent resizer exists)", () => {
    expect(tsSizedMomentImage("ufc", "45663101", 144)).toBeNull()
    expect(tsSizedMomentImage("laliga-golazos", "45663101", 144)).toBeNull()
  })
  it("returns null without a numeric rep_nft_id", () => {
    expect(tsSizedMomentImage("nba-top-shot", null, 144)).toBeNull()
    expect(tsSizedMomentImage("nba-top-shot", undefined, 144)).toBeNull()
    expect(tsSizedMomentImage("nba-top-shot", "abc", 144)).toBeNull()
    expect(tsSizedMomentImage("nba-top-shot", "", 144)).toBeNull()
  })
  it("returns null when the collection slug is absent", () => {
    expect(tsSizedMomentImage(undefined, "45663101", 144)).toBeNull()
  })
})

describe("tileParallelLabel (2026-09-25)", () => {
  it("prefers the RPC's subedition_name, then Candy's name suffix, else null", async () => {
    const { tileParallelLabel } = await import("@/lib/entity-editions-grid-format")
    expect(tileParallelLabel({ subedition_name: " Hexwave " }, "nba-top-shot")).toBe("Hexwave")
    expect(tileParallelLabel({ subedition_name: null, name: "Courtney Lee — Run It Back", player_name: "Courtney Lee" }, "nba-top-shot")).toBeNull()
    expect(tileParallelLabel({ name: "Junior Caminero - ORANGE", player_name: "Junior Caminero" }, "candy-mlb")).toBe("Orange")
    expect(tileParallelLabel({ name: "Junior Caminero", player_name: "Junior Caminero" }, "candy-mlb")).toBeNull()
    expect(tileParallelLabel({ name: "Junior Caminero - ", player_name: "Junior Caminero" }, "candy-mlb")).toBeNull()
    expect(tileParallelLabel({ name: "Junior Caminero - ORANGE", player_name: "Junior Caminero" }, "nfl-all-day")).toBeNull()
    expect(tileParallelLabel({ name: null, player_name: null }, "candy-mlb")).toBeNull()
  })
})

import {
  EMPTY_EDITION_FILTERS,
  editionFilterOptions,
  filterEditions,
  isEditionFilterActive,
} from "@/lib/entity-editions-grid-format"

describe("edition filters (player page, 2026-09-25)", () => {
  const e = (slug: string, over: Record<string, unknown> = {}) => ({
    route_slug: slug, player_name: "P", name: "N " + slug, series_label: "Series 4", series_num: 4,
    tier: "COMMON", tier_rank: 9, team_name: "A", set_name: "Base", ...over,
  })
  const rows = [
    e("a", { tier: "LEGENDARY", tier_rank: 3, series_label: "Series 1", series_num: 1 }),
    e("b", { subedition_name: "Hexwave", team_name: "B" }),
    e("c", { tier: "RARE", tier_rank: 5, series_label: "Series 7", series_num: 7 }),
  ]

  it("options are ordered rarest tier first, newest series first, Standard first", () => {
    const o = editionFilterOptions(rows, "nba-top-shot")
    expect(o.tiers).toEqual(["LEGENDARY", "RARE", "COMMON"])
    expect(o.series).toEqual(["Series 7", "Series 4", "Series 1"])
    expect(o.parallels).toEqual(["Standard", "Hexwave"])
    expect(o.teams).toEqual(["A", "B"])
  })

  it("the empty filter is inactive and matches everything", () => {
    expect(isEditionFilterActive(EMPTY_EDITION_FILTERS)).toBe(false)
    expect(filterEditions(rows, EMPTY_EDITION_FILTERS, "nba-top-shot", null)).toHaveLength(3)
  })

  it("an ownership filter with UNKNOWN counts is a no-op, not 'owns nothing'", () => {
    const f = { ...EMPTY_EDITION_FILTERS, own: "owned" as const }
    expect(filterEditions(rows, f, "nba-top-shot", null)).toHaveLength(3)
    const known = new Map([["b", { owned: 1, locked: 0 }]])
    expect(filterEditions(rows, f, "nba-top-shot", known).map((r) => r.route_slug)).toEqual(["b"])
    expect(filterEditions(rows, { ...f, own: "not_owned" }, "nba-top-shot", known).map((r) => r.route_slug)).toEqual(["a", "c"])
    expect(filterEditions(rows, { ...f, own: "locked" }, "nba-top-shot", known)).toHaveLength(0)
  })

  it("Standard matches only rows with no parallel", () => {
    const f = { ...EMPTY_EDITION_FILTERS, parallel: "Standard" }
    expect(filterEditions(rows, f, "nba-top-shot", null).map((r) => r.route_slug)).toEqual(["a", "c"])
  })
})

import { editionBadgeOptions } from "@/lib/entity-editions-grid-format"

describe("edition badge filter (2026-09-25)", () => {
  const rows = [{ route_slug: "a" }, { route_slug: "b" }, { route_slug: "c" }]
  const base = { player_name: "P", name: "N", series_label: null, tier: null }
  const full = rows.map((r) => ({ ...base, ...r }))

  it("orders badge options rookie-first, then any other title A→Z", () => {
    const m = new Map([["a", ["All-Star", "Zeta Award"]], ["b", ["Top Shot Debut", "Three-Star Rookie"]]])
    expect(editionBadgeOptions(rows, m)).toEqual(["Three-Star Rookie", "Top Shot Debut", "All-Star", "Zeta Award"])
  })

  it("a row with UNKNOWN badges never matches a badge filter; a known [] does not either", () => {
    const m = new Map([["a", ["Rookie Year"]], ["b", []]])
    const f = { ...EMPTY_EDITION_FILTERS, badge: "Rookie Year" }
    expect(filterEditions(full, f, "nba-top-shot", null, m).map((r) => r.route_slug)).toEqual(["a"])
    expect(isEditionFilterActive(f)).toBe(true)
  })
})
