// __tests__/edition-titles-name-the-play.test.ts
//
// 2026-10-21 SEO pass: 71 % of Top Shot edition pages (10,308 / 14,528) and
// 41 % of All Day's shared their <title> with another edition. Five different
// Kon Knueppel Signature Series 1/1s rendered five identical titles. The fix is
// lib/edition-title-context.ts (set · parallel · play · date · /circ), fed by
// get_edition_detail since 20261021142334. Fixtures below are the REAL payload
// values read from production that day.

import { describe, expect, it } from "vitest"
import { editionPageMetadata, editionJsonLd } from "@/lib/seo"
import { editionTitleContext, formatGameDate } from "@/lib/edition-title-context"

const title = (p: Record<string, unknown>, c: string) => {
  const t = editionPageMetadata(p, c).title as unknown
  return typeof t === "string" ? t : String((t as { absolute?: string; default?: string }).absolute ?? (t as { default?: string }).default)
}
const productName = (p: Record<string, unknown>, c: string) =>
  String((editionJsonLd(p, c) as { "@graph": Array<Record<string, unknown>> })["@graph"][0].name)

const knueppel = (route: string, play: string, date: string) => ({
  route_slug: route, external_id: route, player_name: "Kon Knueppel", set_name: "Signature Series",
  play_category: play, play_type: play, game_date: date, subedition_name: null, circulation_count: 1, tier: "ULTIMATE",
})

describe("edition titles name the play, date and parallel", () => {
  it("the five Knueppel Signature Series 1/1s get five distinct titles (the case)", () => {
    const eds = [
      knueppel("260:8820", "Block", "2026-03-02"),
      knueppel("241:8246", "Assist", "2026-02-20"),
      knueppel("241:8444", "3 Pointer", "2026-01-14"),
      knueppel("241:8449", "3 Pointer", "2025-11-08"),
      knueppel("241:8054", "3 Pointer", "2025-12-30"),
    ]
    const titles = eds.map((e) => title(e, "nba-top-shot"))
    expect(new Set(titles).size).toBe(5)
    expect(titles[1]).toBe("Kon Knueppel — Signature Series · Assist · Feb 20, 2026 · Value, Floor & Sales | NBA Top Shot | Rip Packs City")
    // The Product name carries the same context.
    expect(new Set(eds.map((e) => productName(e, "nba-top-shot"))).size).toBe(5)
  })

  it("a Top Shot ::N page names its parallel; its base edition does not", () => {
    const base = { route_slug: "231:8034", player_name: "LaMelo Ball", set_name: "Holo Icon", play_category: "3 Pointer", game_date: "2026-01-06", subedition_name: null }
    const par = { ...base, route_slug: "231:8034::22", subedition_name: "Omega" }
    expect(editionTitleContext(par, "nba-top-shot")).toBe("Holo Icon · Omega · 3 Pointer · Jan 6, 2026")
    expect(editionTitleContext(base, "nba-top-shot")).toBe("Holo Icon · 3 Pointer · Jan 6, 2026")
    // a subedition_name on a NON-:: route is not treated as a parallel
    expect(editionTitleContext({ ...base, subedition_name: "Omega" }, "nba-top-shot")).not.toContain("Omega")
  })

  it("All Day separates tiers of one play and two plays of one game by mint size", () => {
    const ad = (route: string, circ: number) => ({ route_slug: route, player_name: "A.J. Brown", set_name: "Road to 100", play_type: "Reception", game_date: "2023-10-29", circulation_count: circ })
    expect(title(ad("1968", 397), "nfl-all-day")).toContain("Road to 100 · Reception · Oct 29, 2023 · /397")
    expect(title(ad("1968", 397), "nfl-all-day")).not.toBe(title(ad("1971", 618), "nfl-all-day"))
  })

  it("MIRROR: a payload without the new fields keeps the old title exactly", () => {
    const old = { route_slug: "90:3571", player_name: "P", set_name: "Base Set" }
    expect(title(old, "nba-top-shot")).toBe("P — Base Set · Value, Floor & Sales | NBA Top Shot | Rip Packs City")
  })

  it("MIRROR: collections outside the measured three are unchanged (Panini, Candy parallel)", () => {
    const pan = { route_slug: "packcard-1", player_name: "Allen Iverson", set_name: "Prizm", play_type: "x", game_date: "2026-01-01", circulation_count: 2 }
    expect(title(pan, "panini-blockchain")).toBe("Allen Iverson — Prizm · Value & Asks | Panini Blockchain | Rip Packs City")
    const candy = { route_slug: "c", player_name: "Bobby Witt Jr.", set_name: "ICONs", badges: ["Rainbow (Blue)"] }
    expect(editionTitleContext(candy, "candy-mlb")).toBe("ICONs · Rainbow (Blue)")
  })

  it("the game date is formatted by parts — no timezone shift, junk rejected", () => {
    expect(formatGameDate("2026-02-20")).toBe("Feb 20, 2026")
    expect(formatGameDate("2026-01-01T00:00:00Z")).toBe("Jan 1, 2026")
    expect(formatGameDate("2026-13-01")).toBeNull()
    expect(formatGameDate(null)).toBeNull()
  })
})
