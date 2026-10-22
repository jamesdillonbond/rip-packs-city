import { describe, it, expect } from "vitest"
import { filterOptions, foldForMatch, highlightParts, matchRank, textIncludes } from "@/lib/filter-match"
import { filterSniperDeals } from "@/lib/sniper/helpers"
import { filterEditions, EMPTY_EDITION_FILTERS } from "@/lib/entity-editions-grid-format"
import type { SniperDeal } from "@/lib/sniper/types"

describe("filter-match", () => {
  it("ignores accents and case (LaLiga club names)", () => {
    expect(foldForMatch("Atlético de Madrid")).toBe("atletico de madrid")
    expect(filterOptions(["Real Madrid", "Atlético de Madrid", "Málaga CF"], "atletico")).toEqual(["Atlético de Madrid"])
    expect(filterOptions(["Real Madrid", "Málaga CF"], "MALAGA")).toEqual(["Málaga CF"])
    // and the other way round: an accented query finds an accented label
    expect(filterOptions(["Luka Dončić", "Luka Garza"], "dončić")).toEqual(["Luka Dončić"])
  })

  it("needs every word, in any order", () => {
    const teams = ["Portland Trail Blazers", "Portland Fire", "Trail Mix FC"]
    expect(filterOptions(teams, "port blaz")).toEqual(["Portland Trail Blazers"])
    expect(filterOptions(teams, "blazers portland")).toEqual(["Portland Trail Blazers"])
    expect(filterOptions(teams, "port zzz")).toEqual([])
  })

  it("ranks a label-prefix first, then a word-prefix, then anywhere; ties keep list order", () => {
    const teams = ["Golden State Warriors", "Sacramento Kings", "Kings Canyon", "Brooklyn Nets", "Parkings"]
    expect(filterOptions(teams, "kings")).toEqual(["Kings Canyon", "Sacramento Kings", "Parkings"])
    expect(matchRank("Kings Canyon", "kings")).toBe(0)
    expect(matchRank("Sacramento Kings", "kings")).toBe(1)
    expect(matchRank("Parkings", "kings")).toBe(2)
    expect(matchRank("Brooklyn Nets", "kings")).toBe(-1)
  })

  it("an empty or blank query keeps every option in order", () => {
    expect(filterOptions(["b", "a"], "")).toEqual(["b", "a"])
    expect(filterOptions(["b", "a"], "   ")).toEqual(["b", "a"])
  })

  it("matches on the display label when one is given", () => {
    const series = ["0", "8"]
    const label = (v: string) => (v === "0" ? "Series 1" : "Series 2026-27")
    expect(filterOptions(series, "2026", label)).toEqual(["8"])
  })

  it("highlights the matched runs on the ORIGINAL (accented) text", () => {
    expect(highlightParts("Atlético de Madrid", "atle")).toEqual([
      { text: "Atlé", match: true },
      { text: "tico de Madrid", match: false },
    ])
    expect(highlightParts("Portland Trail Blazers", "port blaz").filter((p) => p.match).map((p) => p.text)).toEqual(["Port", "Blaz"])
    expect(highlightParts("Anything", "")).toEqual([{ text: "Anything", match: false }])
  })
})

describe("textIncludes — the free-text search boxes", () => {
  it("is accent- and case-blind, and plain substring otherwise", () => {
    expect(textIncludes("Luka Dončić", "doncic")).toBe(true)
    expect(textIncludes("Luka Dončić", "DONČIĆ")).toBe(true)
    expect(textIncludes("Atlético de Madrid", "tico de")).toBe(true)
    expect(textIncludes("Damian Lillard", "lebron")).toBe(false)
    expect(textIncludes(null, "x")).toBe(false)
    expect(textIncludes("anything", "")).toBe(true)
  })

  // 2026-10-21: every one of these lowercased and called .includes — "doncic"
  // found nothing for "Luka Dončić" on the Sniper and the boards.
  it("Sniper search finds an accented player from an unaccented query", () => {
    const d = (playerName: string) => ({ playerName, setName: "Base", teamName: "Dallas Mavericks", discount: 10 }) as SniperDeal
    expect(filterSniperDeals([d("Luka Dončić"), d("Kyrie Irving")], { search: "doncic" }).map((x) => x.playerName)).toEqual(["Luka Dončić"])
  })

  it("the editions grid's Filter editions box is accent-blind too", () => {
    const e = (player_name: string, route_slug: string) => ({ route_slug, player_name, name: null, team_name: "Real Madrid", set_name: "Base", series_label: null, tier: "COMMON" })
    const rows = [e("Vinícius Júnior", "a"), e("Jude Bellingham", "b")]
    expect(filterEditions(rows, { ...EMPTY_EDITION_FILTERS, q: "vinicius" }, "laliga-golazos", null).map((r) => r.route_slug)).toEqual(["a"])
  })

  it("the market's Did-you-mean offers only names the accent-sensitive route MISSED", async () => {
    const { accentOnlyMatches } = await import("@/app/(collections)/[collection]/market/MarketClient")
    const names = ["Luka Dončić", "Luka Garza", "Nikola Jokić"]
    expect(accentOnlyMatches("luka doncic", names)).toEqual(["Luka Dončić"])
    // "luka" already matches both via ilike: an empty page there is a true empty — no hint
    expect(accentOnlyMatches("luka", names)).toEqual([])
    expect(accentOnlyMatches("  ", names)).toEqual([])
  })
})
