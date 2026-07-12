import { describe, it, expect } from "vitest"
import {
  marketplaceMomentUrl,
  marketplaceWalletUrl,
  dapperMarketMomentUrl,
  dapperMarketPacksBrowseUrl,
} from "@/lib/collections"

// Outbound marketplace deep-links. These render as "View Listing" / "Buy on X"
// CTAs — the intelligence-first product's whole point is honest, correct
// outbound links, so a wrong or non-null-when-it-should-be-null link sends a
// collector to a 404. Pin per-collection templates and the null cases.

describe("marketplaceMomentUrl (native marketplace)", () => {
  it("resolves per-collection native moment links", () => {
    expect(marketplaceMomentUrl("nba-top-shot", "123")).toBe(
      "https://nbatopshot.com/moment/123"
    )
    expect(marketplaceMomentUrl("nfl-all-day", "123")).toBe(
      "https://nflallday.com/moments/123"
    )
    expect(marketplaceMomentUrl("disney-pinnacle", "123")).toBe(
      "https://disneypinnacle.com/pin/123"
    )
  })

  it("returns null for UFC (no native moment template) and unknown collections", () => {
    expect(marketplaceMomentUrl("ufc", "123")).toBeNull()
    expect(marketplaceMomentUrl("not-a-collection", "123")).toBeNull()
  })
})

describe("marketplaceWalletUrl", () => {
  it("resolves per-collection wallet/collection links", () => {
    expect(marketplaceWalletUrl("nba-top-shot", "0xabc")).toBe(
      "https://nbatopshot.com/user/0xabc"
    )
    expect(marketplaceWalletUrl("nfl-all-day", "0xabc")).toBe(
      "https://nflallday.com/collection/0xabc"
    )
  })

  it("returns null for UFC and unknown collections", () => {
    expect(marketplaceWalletUrl("ufc", "0xabc")).toBeNull()
    expect(marketplaceWalletUrl("not-a-collection", "0xabc")).toBeNull()
  })
})

describe("dapperMarketMomentUrl (dapper.market secondary)", () => {
  it("maps only the three leagues on dapper.market", () => {
    expect(dapperMarketMomentUrl("nba-top-shot", "999")).toBe(
      "https://dapper.market/nba/moment/999"
    )
    expect(dapperMarketMomentUrl("nfl-all-day", "999")).toBe(
      "https://dapper.market/nfl/moment/999"
    )
    expect(dapperMarketMomentUrl("laliga-golazos", "999")).toBe(
      "https://dapper.market/laliga/moment/999"
    )
  })

  it("returns null for collections not on dapper.market", () => {
    expect(dapperMarketMomentUrl("disney-pinnacle", "999")).toBeNull()
    expect(dapperMarketMomentUrl("ufc", "999")).toBeNull()
  })

  it("returns null when momentId is missing", () => {
    expect(dapperMarketMomentUrl("nba-top-shot", null)).toBeNull()
    expect(dapperMarketMomentUrl("nba-top-shot", undefined)).toBeNull()
    expect(dapperMarketMomentUrl("nba-top-shot", "")).toBeNull()
  })
})

describe("dapperMarketPacksBrowseUrl", () => {
  it("returns NBA / NFL pack-grid links only", () => {
    expect(dapperMarketPacksBrowseUrl("nba-top-shot")).toBe(
      "https://dapper.market/nba/search/packs?packSource=marketplace"
    )
    expect(dapperMarketPacksBrowseUrl("nfl-all-day")).toBe(
      "https://dapper.market/nfl/search/packs?packSource=marketplace"
    )
  })

  it("returns null for Golazos (no packs on dapper.market) and others", () => {
    expect(dapperMarketPacksBrowseUrl("laliga-golazos")).toBeNull()
    expect(dapperMarketPacksBrowseUrl("disney-pinnacle")).toBeNull()
    expect(dapperMarketPacksBrowseUrl("ufc")).toBeNull()
  })
})
