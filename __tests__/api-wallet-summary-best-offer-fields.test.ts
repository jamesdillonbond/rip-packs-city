import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { bestOfferFields } from "@/app/api/wallet-summary/route"

// 2026-11-14: get_wallet_edition_bid_total reads edition_offers / badge_editions. A collection whose
// bids live elsewhere (Pinnacle) comes back as 0 editions — that must read as "not known", never
// as "$0 in bids".
describe("bestOfferFields", () => {
  it("attaches the wallet-wide total when bids were found", () => {
    expect(bestOfferFields({ best_offer_total: 28541, best_offer_editions: 2983, best_offer_paired_fmv: 38768.05, best_offer_paired_offer: 28541 }))
      .toEqual({ best_offer_total: 28541, best_offer_editions: 2983, best_offer_paired_fmv: 38768.05, best_offer_paired_offer: 28541 })
  })
  it("attaches NOTHING for a zero-edition answer (a source that cannot see the collection)", () => {
    expect(bestOfferFields({ best_offer_total: 0, best_offer_editions: 0, best_offer_paired_fmv: 0, best_offer_paired_offer: 0 })).toEqual({})
  })
  it("attaches nothing for a failed read", () => {
    expect(bestOfferFields(null)).toEqual({})
    expect(bestOfferFields(undefined)).toEqual({})
  })
})
