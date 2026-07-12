import { describe, it, expect } from "vitest"
import { topshotPackUrl, alldayPackUrl, dapperMarketPackUrl } from "@/lib/pack-urls"

// Single caller-facing home for pack deep-links. Pin the shapes + encoding so a
// distId with special chars can't produce a malformed outbound link.

describe("topshotPackUrl", () => {
  it("builds the packDetail query link, URL-encoding the distId", () => {
    expect(topshotPackUrl({ distId: "8524" })).toBe(
      "https://nbatopshot.com/?packDetail=8524"
    )
    expect(topshotPackUrl({ distId: "a b" })).toContain("packDetail=a%20b")
  })
})

describe("alldayPackUrl", () => {
  it("builds the /pack/<id> link", () => {
    expect(alldayPackUrl({ packListingId: "7578" })).toBe("https://nflallday.com/pack/7578")
  })
})

describe("dapperMarketPackUrl", () => {
  it("builds the league pack-search deep link with packDetail", () => {
    expect(dapperMarketPackUrl({ league: "nba", distId: "5427" })).toBe(
      "https://dapper.market/nba/search/packs?packSource=marketplace&packDetail=5427"
    )
    expect(dapperMarketPackUrl({ league: "nfl", distId: "7578" })).toContain("/nfl/search/packs")
  })
})
