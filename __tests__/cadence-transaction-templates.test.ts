import { describe, it, expect } from "vitest"
import { GIFT_MOMENT_CADENCE, GIFT_MOMENT_GAS_LIMIT } from "@/lib/chains/flow/cadence/gift-moment"
import {
  PURCHASE_MOMENT_CADENCE,
  DAPPER_MERCHANT_ADDRESS,
  TOPSHOT_CONTRACT_ADDRESS,
  NFT_STOREFRONT_V2_ADDRESS,
  DUC_CONTRACT_ADDRESS,
} from "@/lib/chains/flow/cadence/purchase-moment"
import {
  MAKE_OFFER_TOPSHOT_CADENCE,
  CANCEL_OFFER_TOPSHOT_CADENCE,
  OFFERS_V2_ADDRESS,
  TOPSHOT_ROYALTY_ADDRESS,
  TOPSHOT_ROYALTY_RATE,
  DAPPER_MERCHANT_ADDRESS as OFFER_MERCHANT_ADDRESS,
} from "@/lib/chains/flow/cadence/make-offer-topshot"
import {
  MAKE_OFFER_FLOWTY_CADENCE,
  FLOWTY_OFFERS_ADDRESS,
  FLOWTY_ROYALTY_ADDRESS,
  FLOWTY_ROYALTY_RATE,
} from "@/lib/chains/flow/cadence/make-offer-flowty"

// The four write-path Cadence transaction templates. Every one of them is
// SHELVED — Cart (#1) and Trade Hub (#3) are intelligence-first decisions, and
// gifting has never run end-to-end (moment_gifts has 0 rows) — which is exactly
// why they had ZERO coverage and exactly why they need a structural pin: nothing
// exercises them, so a bad edit sits undetected until the day someone revives
// the path and signs a real transaction with it.
//
// These are string templates, so the checkable properties are the ones CLAUDE.md
// treats as non-negotiable for this repo:
//   - Cadence 1.0 syntax ONLY — `auth(...) &Account`, never the pre-1.0
//     `AuthAccount`; `access(all)`, never `pub`.
//   - the deployed mainnet contract addresses, which are enumerated in
//     CLAUDE.md and must not drift silently (a wrong address is a transaction
//     that either fails or, worse, pays the wrong account).
//   - the Dapper dual-signer + DUC-leak `post{}` invariants that Dapper's
//     co-signer actually enforces.

/** Signer count = the number of `&Account` params in the prepare header. A
 *  naive `prepare\(([^)]*)\)` capture stops at the `)` inside `auth(...)`, so
 *  count the entitled references instead. */
function signerCount(src: string): number {
  const start = src.indexOf("prepare")
  if (start < 0) return 0
  // Take up to the opening brace of the prepare body.
  const header = src.slice(start, src.indexOf("{", start))
  return (header.match(/&Account/g) ?? []).length
}

const ALL_TEMPLATES: Array<[string, string]> = [
  ["gift-moment", GIFT_MOMENT_CADENCE],
  ["purchase-moment", PURCHASE_MOMENT_CADENCE],
  ["make-offer-topshot", MAKE_OFFER_TOPSHOT_CADENCE],
  ["cancel-offer-topshot", CANCEL_OFFER_TOPSHOT_CADENCE],
  ["make-offer-flowty", MAKE_OFFER_FLOWTY_CADENCE],
]

describe("Cadence transaction templates — 1.0 syntax", () => {
  it.each(ALL_TEMPLATES)("%s is non-empty and declares a transaction", (_name, src) => {
    expect(src.trim().length).toBeGreaterThan(0)
    expect(src).toMatch(/transaction\s*\(?/)
  })

  it.each(ALL_TEMPLATES)("%s uses no pre-1.0 AuthAccount or pub declarations", (_name, src) => {
    // Cadence 1.0 replaced AuthAccount with `auth(Entitlement) &Account` and
    // `pub` with `access(all)`. Either survivor fails at parse time on mainnet.
    expect(src).not.toMatch(/\bAuthAccount\b/)
    expect(src).not.toMatch(/^\s*pub\s+(fun|let|var|resource|struct|contract)\b/m)
  })

  it.each(ALL_TEMPLATES)("%s declares its signers with an entitled &Account reference", (_name, src) => {
    expect(src).toMatch(/auth\([^)]+\)\s*&Account/)
  })
})

describe("purchase-moment — the Dapper dual-signer contract", () => {
  it("pins the four mainnet addresses CLAUDE.md enumerates", () => {
    expect(DAPPER_MERCHANT_ADDRESS).toBe("0xc1e4f4f4c4257510")
    expect(TOPSHOT_CONTRACT_ADDRESS).toBe("0x0b2a3299cc857e29")
    expect(NFT_STOREFRONT_V2_ADDRESS).toBe("0x4eb8a10cb9f87357")
    // NOT 0x82ec283f88a62e65 — that alias was retired.
    expect(DUC_CONTRACT_ADDRESS).toBe("0xead892083b3e2c6c")
  })

  it("takes TWO signers (buyer + the Dapper co-signer) and carries the DUC-leak post block", () => {
    // Dapper's meta-transaction co-signer rejects a transaction that can leave
    // DUC stranded, so the balance assertion is not optional decoration.
    expect(signerCount(PURCHASE_MOMENT_CADENCE)).toBe(2)
    expect(PURCHASE_MOMENT_CADENCE).toContain("post")
    expect(PURCHASE_MOMENT_CADENCE).toMatch(/DapperUtilityCoin|dapperUtilityCoin|DUC/)
  })

  it("imports the storefront it buys through", () => {
    expect(PURCHASE_MOMENT_CADENCE).toMatch(/import\s+NFTStorefrontV2/)
  })
})

describe("gift-moment — single parent signer over Hybrid Custody", () => {
  it("borrows the child through HybridCustody and deposits via the public receiver", () => {
    expect(GIFT_MOMENT_CADENCE).toMatch(/import\s+HybridCustody/)
    expect(GIFT_MOMENT_CADENCE).toContain("borrowAccount")
    expect(GIFT_MOMENT_CADENCE).toContain("/public/MomentCollection")
    expect(GIFT_MOMENT_CADENCE).toContain("deposit")
  })

  it("has exactly ONE prepare signer — there is no Dapper co-signer on this path", () => {
    // Withdraw authority was pre-granted at account-link time, so adding a
    // second signer here would be a real behavioural change, not a typo.
    expect(signerCount(GIFT_MOMENT_CADENCE)).toBe(1)
  })

  it("ships a concrete gas limit", () => {
    expect(GIFT_MOMENT_GAS_LIMIT).toBe(999)
  })
})

describe("offer templates — royalty + escrow addresses", () => {
  it("pins the Top Shot DapperOffersV2 constants", () => {
    expect(OFFERS_V2_ADDRESS).toBe("0xb8ea91944fd51c43")
    expect(TOPSHOT_ROYALTY_ADDRESS).toBe("0xfaf0cc52c6e3acaf")
    expect(TOPSHOT_ROYALTY_RATE).toBe(0.05)
    expect(OFFER_MERCHANT_ADDRESS).toBe("0xc1e4f4f4c4257510")
  })

  it("pins the Flowty offer constants, whose royalty is three orders of magnitude smaller", () => {
    expect(FLOWTY_OFFERS_ADDRESS).toBe("0x322d96c958eb8c46")
    expect(FLOWTY_ROYALTY_ADDRESS).toBe("0x6590f8918060ef13")
    expect(FLOWTY_ROYALTY_RATE).toBe(0.00025)
    // A copy-paste of the Top Shot rate here would overcharge every offer 200x.
    expect(FLOWTY_ROYALTY_RATE).toBeLessThan(TOPSHOT_ROYALTY_RATE)
  })

  it("the make/cancel pair target the same offers contract", () => {
    expect(MAKE_OFFER_TOPSHOT_CADENCE).toMatch(/import\s+(DapperOffersV2|Offers)/)
    expect(CANCEL_OFFER_TOPSHOT_CADENCE).toMatch(/import\s+(DapperOffersV2|Offers)/)
  })
})
