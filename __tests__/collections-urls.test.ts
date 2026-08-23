import { describe, it, expect } from "vitest"
import {
  marketplaceMomentUrl,
  marketplaceWalletUrl,
  dapperMarketMomentUrl,
  dapperMarketPacksBrowseUrl,
  dapperMarketEditionUrl,
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

describe("dapperMarketEditionUrl (dapper.market edition grain)", () => {
  it("builds the Golazos edition link from the on-chain editionID", () => {
    // Verified against a live page 2026-08-22: Golazos edition 541 is the
    // Messi ElClásico /11, and editions.external_id for it is exactly "541".
    expect(dapperMarketEditionUrl("laliga-golazos", "541")).toBe(
      "https://dapper.market/laliga/edition/541"
    )
  })

  it("returns null for collections with no VERIFIED edition-URL shape", () => {
    // Not "collections that are absent from dapper.market" — nba/nfl moments DO
    // resolve there. These are null because no edition URL has been confirmed
    // (nfl-all-day) or is derivable from external_id at all (nba-top-shot).
    // If someone adds a seg entry, they must delete the matching line here, and
    // that deletion is the prompt to verify a real page first.
    expect(dapperMarketEditionUrl("nba-top-shot", "541")).toBeNull()
    expect(dapperMarketEditionUrl("nfl-all-day", "541")).toBeNull()
    expect(dapperMarketEditionUrl("disney-pinnacle", "541")).toBeNull()
    expect(dapperMarketEditionUrl("ufc", "541")).toBeNull()
  })

  it("refuses a non-numeric external_id even for a mapped collection", () => {
    // The second gate. Top Shot external_ids are composites
    // ("<setUUID>:<playUUID>", "258:9004::16") and UFC/Candy ones are slugs;
    // none may ever be pasted into an /edition/<id> path. Asserted against the
    // MAPPED collection so the seg map can't be what makes it pass.
    expect(dapperMarketEditionUrl("laliga-golazos", "258:9004::16")).toBeNull()
    expect(
      dapperMarketEditionUrl("laliga-golazos", "0055c39d-724b-444f-918f-ddff017151f5:02525340-0bd9-423f-b502-b62a80bf63bf")
    ).toBeNull()
    expect(dapperMarketEditionUrl("laliga-golazos", "aaron-judge")).toBeNull()
    expect(dapperMarketEditionUrl("laliga-golazos", "541 ")).toBeNull()
  })

  it("returns null when the external_id is missing", () => {
    expect(dapperMarketEditionUrl("laliga-golazos", null)).toBeNull()
    expect(dapperMarketEditionUrl("laliga-golazos", undefined)).toBeNull()
    expect(dapperMarketEditionUrl("laliga-golazos", "")).toBeNull()
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
