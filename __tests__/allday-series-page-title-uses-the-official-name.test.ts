// 2026-11-24 — /nfl-all-day/series/series-9 rendered an H1 of "2025 Season" (after the
// series-label fix) but its <title>/og:title still said "Series 9 (Season 2025)": the
// metadata builder decoded only Top Shot. All Day's own on-chain names win here too.
import { describe, expect, it } from "vitest"
import { seriesPageMetadata } from "@/lib/seo"

const title = (m: ReturnType<typeof seriesPageMetadata>) => String((m.title as { absolute?: string })?.absolute ?? m.title)

describe("All Day series page metadata", () => {
  it("titles on-chain 9 as '2025 Season', never 'Series 9'", () => {
    const t = title(seriesPageMetadata({ display_label: "Series 9", series_number: 9, season: "2025", edition_count: 10 }, "nfl-all-day", "series-9"))
    expect(t).toContain("2025 Season")
    expect(t).not.toContain("Series 9")
    expect(t.split("2025").length - 1).toBe(1)
  })
  it("a Historical release is not called a season", () => {
    const t = title(seriesPageMetadata({ display_label: "Series 2", series_number: 2, season: "2022", edition_count: 10 }, "nfl-all-day", "series-2"))
    expect(t).toContain("Historical")
    expect(t).not.toContain("Season 2022")
  })
  it("another collection keeps its stored label", () => {
    const t = title(seriesPageMetadata({ display_label: "Series 1", series_number: 1, season: "2022-23", edition_count: 10 }, "laliga-golazos", "series-1"))
    expect(t).toContain("Series 1")
  })
})
