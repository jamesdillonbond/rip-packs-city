import { describe, it, expect } from "vitest"
import { unknownPurchaseFns } from "../scripts/lib/aptos-marketplace-fns.mjs"

// The UFC Aptos sales lane filters on a fixed list of purchase entry functions. This control is what
// separates "the market was quiet" from "the marketplace moved to a function we do not read"
// (2026-11-20: 0 buys of ANY collection on every run 11-17 → 11-20 looked identical to a quiet market).
const TP = "0xe11c12ec495f3989c35e1c6a0af414451223305b579291fc8f3d9d0575a23c26"
const KNOWN = [`${TP}::markets_v2::buy_tokens_v2`, `${TP}::biddings_v2::accept_collection_bid`, `${TP}::biddings_v2::unlist_and_accept_collection_bid`]

describe("unknownPurchaseFns", () => {
  it("names a purchase function the lane does not know (a new market version)", () => {
    expect(unknownPurchaseFns([`${TP}::markets_v3::buy_tokens_v3`, ...KNOWN], KNOWN)).toEqual([`${TP}::markets_v3::buy_tokens_v3`])
  })

  it("an accept inside an unlist_and_ name is still a purchase", () => {
    expect(unknownPurchaseFns([`${TP}::biddings_v3::unlist_and_accept_token_bid`], KNOWN)).toEqual([`${TP}::biddings_v3::unlist_and_accept_token_bid`])
  })

  it("never flags a known function, whatever its case", () => {
    expect(unknownPurchaseFns(KNOWN.map((f) => f.toUpperCase()), KNOWN)).toEqual([])
  })

  it("listing, unlisting, cancelling and bidding are not purchases", () => {
    const seen = [`${TP}::markets_v2::list_token`, `${TP}::markets_v2::unlist_token`, `${TP}::markets_v3::cancel_listing`, `${TP}::biddings_v2::place_bid`, `${TP}::biddings_v2::bid`]
    expect(unknownPurchaseFns(seen, KNOWN)).toEqual([])
  })

  it("is satisfiable at a population of zero (an empty range flags nothing)", () => {
    expect(unknownPurchaseFns([], KNOWN)).toEqual([])
  })
})
