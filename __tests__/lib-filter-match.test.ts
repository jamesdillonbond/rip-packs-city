import { describe, it, expect } from "vitest"
import { filterOptions, foldForMatch, highlightParts, matchRank } from "@/lib/filter-match"

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
