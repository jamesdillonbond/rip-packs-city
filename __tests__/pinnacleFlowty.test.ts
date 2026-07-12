import { describe, it, expect } from "vitest"
import {
  extractEditionKeyFromNft,
  flowtyNftToSniperDeals,
  type FlowtyPinnacleNft,
} from "@/lib/pinnacle/pinnacleFlowty"

// lib/pinnacle/pinnacleFlowty.ts — pure parsers/mappers only (the fetch fns are
// skipped). extractEditionKeyFromNft reads the nftView traits into the composite
// "ROYALTY:VARIANT:PRINTING" edition key. flowtyNftToSniperDeals is deterministic
// when a real blockTimestamp is supplied (its only Date.now path is the missing-
// timestamp fallback, which we never exercise here).

function nft(
  traits: Record<string, string>,
  over: Partial<FlowtyPinnacleNft> = {},
): FlowtyPinnacleNft {
  return {
    id: "nft-1",
    owner: "0xowner",
    card: { title: "T", max: null, images: [{ url: "https://img/1.png" }] },
    nftView: {
      traits: {
        traits: Object.entries(traits).map(([name, value]) => ({ name, value })),
      },
    },
    orders: [],
    offers: [],
    ...over,
  }
}

describe("extractEditionKeyFromNft", () => {
  it("builds the edition key from RoyaltyCodes/Variant/Printing traits", () => {
    const out = extractEditionKeyFromNft(
      nft({
        RoyaltyCodes: "[WDAS-OEV1-LION]",
        Variant: "Golden",
        Printing: "2",
      }),
    )
    expect(out).toEqual({
      editionKey: "WDAS-OEV1-LION:Golden:2",
      royaltyCode: "WDAS-OEV1-LION",
      variant: "Golden",
      printing: 2,
    })
  })

  it("defaults Variant='Standard', printing=1, royaltyCode='' when traits missing", () => {
    const out = extractEditionKeyFromNft(nft({}))
    expect(out).toEqual({
      editionKey: ":Standard:1",
      royaltyCode: "",
      variant: "Standard",
      printing: 1,
    })
  })

  it("takes the first royalty code from a multi-value stringified array", () => {
    const out = extractEditionKeyFromNft(
      nft({ RoyaltyCodes: "[CODE-A, CODE-B]", Variant: "Standard" }),
    )
    expect(out.royaltyCode).toBe("CODE-A")
    expect(out.editionKey).toBe("CODE-A:Standard:1")
  })
})

describe("flowtyNftToSniperDeals", () => {
  const fmv = new Map([["OE-CODE:Standard:1", { fmv: 100, confidence: "HIGH" }]])

  function openEditionNft(salePrice: number, state = "LISTED"): FlowtyPinnacleNft {
    return nft(
      { RoyaltyCodes: "[OE-CODE]", Variant: "Standard", EditionType: "Open Edition" },
      {
        orders: [
          {
            salePrice,
            listingResourceID: "lr-1",
            storefrontAddress: "0xstore",
            state,
            listingKind: "sale",
            blockTimestamp: 1_700_000_000_000, // ms
            nftID: "nft-1",
            paymentTokenName: "DUC",
          },
        ],
      },
    )
  }

  it("returns [] when the royalty code is missing", () => {
    expect(flowtyNftToSniperDeals(nft({ Variant: "Standard" }), fmv)).toEqual([])
  })

  it("returns [] when the edition has no FMV entry", () => {
    expect(flowtyNftToSniperDeals(openEditionNft(50), new Map())).toEqual([])
  })

  it("returns [] when there are no LISTED orders", () => {
    expect(flowtyNftToSniperDeals(openEditionNft(50, "CANCELLED"), fmv)).toEqual([])
  })

  it("returns [] when the discount is below the 5% threshold", () => {
    // ask 98 vs fmv 100 -> 2% discount, filtered out
    expect(flowtyNftToSniperDeals(openEditionNft(98), fmv)).toEqual([])
  })

  it("maps a discounted LISTED order to one deal with deterministic fields", () => {
    const deals = flowtyNftToSniperDeals(openEditionNft(50), fmv)
    expect(deals).toHaveLength(1)
    const d = deals[0]
    expect(d.editionKey).toBe("OE-CODE:Standard:1")
    expect(d.askPrice).toBe(50)
    expect(d.baseFmv).toBe(100)
    expect(d.adjustedFmv).toBe(100) // OE -> serialMult 1.0
    expect(d.serialMult).toBe(1)
    expect(d.discount).toBe(50) // (100-50)/100 = 50%
    expect(d.confidence).toBe("HIGH")
    expect(d.source).toBe("pinnacle")
    expect(d.flowId).toBe("nft-1")
    expect(d.serial).toBeNull()
    expect(d.isSpecialSerial).toBe(false)
    expect(d.updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it("treats a seconds-grain blockTimestamp as seconds (x1000)", () => {
    const n = openEditionNft(50)
    n.orders[0].blockTimestamp = 1_700_000_000 // seconds
    const deals = flowtyNftToSniperDeals(n, fmv)
    expect(deals[0].updatedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })
})
