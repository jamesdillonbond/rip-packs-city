import { describe, it, expect } from "vitest"
import {
  extractNftTypeId,
  isTopShotNftType,
  normAddr,
  parseOfferCompletedFill,
} from "@/lib/chains/flow/topshot-offer-fill"

// Pure decode helpers for DapperOffers OfferCompleted → sale-row fills. Offer-fill
// attribution has been a real bug surface (buyer/seller swap, parallel mis-keying,
// the offer_fill guard), and these parsers are where a fill is classified before
// it becomes a sales row. Previously untested.

describe("extractNftTypeId", () => {
  it("passes a plain string type id through", () => {
    expect(extractNftTypeId("A.0b2a3299cc857e29.TopShot.NFT")).toBe("A.0b2a3299cc857e29.TopShot.NFT")
  })
  it("reads staticType as a string", () => {
    expect(extractNftTypeId({ staticType: "A.x.TopShot.NFT" })).toBe("A.x.TopShot.NFT")
  })
  it("reads a nested staticType.typeID", () => {
    expect(extractNftTypeId({ staticType: { typeID: "A.x.TopShot.NFT" } })).toBe("A.x.TopShot.NFT")
  })
  it("returns undefined for unrecognized shapes", () => {
    expect(extractNftTypeId(null)).toBeUndefined()
    expect(extractNftTypeId(42)).toBeUndefined()
    expect(extractNftTypeId({})).toBeUndefined()
  })
})

describe("isTopShotNftType", () => {
  it("is true only for a *.TopShot.NFT type id", () => {
    expect(isTopShotNftType("A.0b2a3299cc857e29.TopShot.NFT")).toBe(true)
    expect(isTopShotNftType({ staticType: { typeID: "A.x.TopShot.NFT" } })).toBe(true)
  })
  it("is false for AllDay / unknown / missing types", () => {
    expect(isTopShotNftType("A.e4cf4bdc1751c65d.AllDay.NFT")).toBe(false)
    expect(isTopShotNftType(null)).toBe(false)
  })
})

describe("normAddr", () => {
  it("lowercases and normalizes the 0x prefix", () => {
    expect(normAddr("0xBD94CADE097E50AC")).toBe("0xbd94cade097e50ac")
    expect(normAddr("bd94cade097e50ac")).toBe("0xbd94cade097e50ac")
    expect(normAddr("  0xAbC  ")).toBe("0xabc")
  })
  it("returns null for null/empty", () => {
    expect(normAddr(null)).toBeNull()
    expect(normAddr(undefined)).toBeNull()
    expect(normAddr("0x")).toBeNull()
  })
})

describe("parseOfferCompletedFill", () => {
  const base = {
    purchased: true,
    nftType: "A.0b2a3299cc857e29.TopShot.NFT",
    offerId: "555",
    offerAmount: "120.0",
    nftId: "987",
    offerAddress: "0xBUYER00000000",
    acceptingAddress: "0xSELLER0000000",
    offerParamsString: { _type: "TopShotEdition", setId: "84", playId: "2892" },
  }

  it("parses an edition offer fill: buyer/seller normalized, externalId setId:playId", () => {
    const f = parseOfferCompletedFill(base, "0xfilltx", "2026-07-01T00:00:00Z", 100)!
    expect(f).not.toBeNull()
    expect(f.offerId).toBe("555")
    expect(f.offerType).toBe("edition")
    expect(f.externalId).toBe("84:2892")
    expect(f.buyer).toBe("0xbuyer00000000")
    expect(f.seller).toBe("0xseller0000000")
    expect(f.amount).toBe(120)
    expect(f.nftId).toBe("987")
  })

  it("classifies a subedition offer", () => {
    const f = parseOfferCompletedFill(
      { ...base, offerParamsString: { _type: "TopShotSubedition", setId: "84", playId: "2892" } },
      "0xtx", "t", null,
    )!
    expect(f.offerType).toBe("subedition")
    expect(f.externalId).toBe("84:2892")
  })

  it("classifies a serial (NFT) offer with no externalId", () => {
    const f = parseOfferCompletedFill({ ...base, offerParamsString: { _type: "NFT" } }, "0xtx", "t", null)!
    expect(f.offerType).toBe("serial")
    expect(f.externalId).toBeNull()
  })

  it("returns null for a cancelled offer (purchased !== true)", () => {
    expect(parseOfferCompletedFill({ ...base, purchased: false }, "0xtx", "t", null)).toBeNull()
  })

  it("returns null for a non-TopShot nft type", () => {
    expect(parseOfferCompletedFill({ ...base, nftType: "A.x.AllDay.NFT" }, "0xtx", "t", null)).toBeNull()
  })

  it("returns null when offerId or fillTx is missing", () => {
    expect(parseOfferCompletedFill({ ...base, offerId: null }, "0xtx", "t", null)).toBeNull()
    expect(parseOfferCompletedFill(base, "", "t", null)).toBeNull()
  })

  it("tolerates a non-positive amount (leaves it NaN for the offers-row fallback)", () => {
    const f = parseOfferCompletedFill({ ...base, offerAmount: "0" }, "0xtx", "t", null)!
    expect(Number.isNaN(f.amount)).toBe(true)
  })
})
